// Non-destructive schema delta for db/passport.db against the CURRENT model
// (NIGHTPASS + the @odatano/nightgate plugin). Adapted from NIGHTGATE's
// scripts/apply-schema-delta.mjs (not shipped in the npm package) for the
// 0.13.0 -> 0.15.1 upgrade: new plugin tables (midnight_AgentGrants), the
// midnight_PredicateAttestations rebuild (op/threshold NOT NULL relaxed,
// new expectedDigest/setRoot columns), and any additive NIGHTPASS columns.
//
// What it does, in ONE transaction:
//   - CREATE TABLE only when the table is ABSENT (existing data untouched)
//   - ALTER TABLE ADD COLUMN for columns missing from an EXISTING table
//   - table REBUILD (create target shape, copy rows, swap) when a column's
//     NOT NULL was dropped in the target schema (SQLite cannot ALTER that)
//   - DROP + CREATE every model-managed VIEW; views the model does not manage
//     are snapshotted and restored, or the whole migration rolls back
//
// This subsumes scripts/refresh-views.mjs for the same run. We NEVER run
// cds.deploy against a live DB (drop + reseed).
//
// Run with the server STOPPED (SQLite is single-writer):
//   node scripts/apply-plugin-schema-delta.mjs
// PASSPORT_DB overrides the default db/passport.db target.
import cds from '@sap/cds';
import Database from 'better-sqlite3';

const DB_PATH = process.env.PASSPORT_DB || 'db/passport.db';
console.log(`[delta] target: ${DB_PATH}`);

await cds.plugins;
const model = cds.linked(await cds.load('*'));
const ddl = cds.compile.to.sql(model, { dialect: 'sqlite' });
const statements = (Array.isArray(ddl) ? ddl : String(ddl).split(/;\s*\n/))
    .map((s) => String(s).trim())
    .filter(Boolean);

const db = new Database(DB_PATH);
const existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
);

let createdTables = 0, addedColumns = 0, refreshedViews = 0, reconciled = 0;
let rebuiltTables = 0, restoredViews = 0;

/** Parse top-level column definitions out of a CREATE TABLE statement. */
function parseColumns(createStmt) {
    const body = createStmt.slice(createStmt.indexOf('(') + 1, createStmt.lastIndexOf(')'));
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of body) {
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const cols = [];
    for (const raw of parts) {
        const p = raw.trim();
        // Table-level constraints cannot be ADD COLUMN'd.
        if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(p)) continue;
        const m = p.match(/^("?)(\w+)\1\s+/);
        if (m) cols.push({ name: m[2], def: p });
    }
    return cols;
}

/** Columns whose NOT NULL was relaxed in the target schema. */
function relaxedColumns(name, createStmt) {
    const info = new Map(
        db.prepare(`PRAGMA table_info("${name}")`).all().map((r) => [r.name, r])
    );
    const relaxed = [];
    for (const col of parseColumns(createStmt)) {
        const cur = info.get(col.name);
        if (!cur) continue;
        const targetNotNull = /\bNOT\s+NULL\b/i.test(col.def);
        if (cur.notnull === 1 && !targetNotNull && cur.pk === 0) relaxed.push(col.name);
    }
    return relaxed;
}

function rebuildTable(name, createStmt) {
    const have = new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map((r) => r.name));
    const shared = parseColumns(createStmt).map((c) => c.name).filter((n) => have.has(n));
    const colList = shared.map((n) => `"${n}"`).join(', ');
    const tmp = `__delta_new_${name}`;
    const tmpStmt = createStmt.replace(/^CREATE TABLE\s+("?)([A-Za-z0-9_]+)\1/i, `CREATE TABLE "${tmp}"`);
    db.exec(`DROP TABLE IF EXISTS "${tmp}";`);
    db.exec(tmpStmt + ';');
    db.exec(`INSERT INTO "${tmp}" (${colList}) SELECT ${colList} FROM "${name}";`);
    db.exec(`DROP TABLE "${name}";`);
    db.exec(`ALTER TABLE "${tmp}" RENAME TO "${name}";`);
}

const tx = db.transaction(() => {
    // Drop ALL views up front: they may reference tables rebuilt below. Views
    // the model manages are recreated in this transaction; any other view is
    // snapshotted and restored, or the whole migration rolls back.
    const preViews = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='view'").all();
    for (const v of preViews) db.exec(`DROP VIEW IF EXISTS "${v.name}";`);

    const recreatedViews = new Set();
    for (const stmt of statements) {
        const tableMatch = stmt.match(/^CREATE TABLE\s+("?)([A-Za-z0-9_]+)\1/i);
        const viewMatch = stmt.match(/^CREATE VIEW\s+("?)([A-Za-z0-9_]+)\1/i);
        if (tableMatch) {
            const name = tableMatch[2];
            if (existingTables.has(name)) {
                const relaxed = relaxedColumns(name, stmt);
                if (relaxed.length > 0) {
                    rebuildTable(name, stmt);
                    console.log(`[delta] ~ rebuilt ${name} (relaxed NOT NULL: ${relaxed.join(', ')})`);
                    rebuiltTables++;
                    reconciled++;
                    continue;
                }
                const have = new Set(
                    db.prepare(`PRAGMA table_info("${name}")`).all().map((r) => r.name)
                );
                for (const col of parseColumns(stmt)) {
                    if (have.has(col.name)) continue;
                    // SQLite ADD COLUMN cannot introduce NOT NULL without a
                    // DEFAULT; additive fields are nullable.
                    let def = col.def;
                    if (/\bNOT\s+NULL\b/i.test(def) && !/\bDEFAULT\b/i.test(def)) {
                        def = def.replace(/\bNOT\s+NULL\b/i, '').replace(/\s{2,}/g, ' ').trim();
                    }
                    db.exec(`ALTER TABLE "${name}" ADD COLUMN ${def};`);
                    console.log(`[delta] + column ${name}.${col.name}`);
                    addedColumns++;
                }
                reconciled++;
                continue;
            }
            db.exec(stmt + ';');
            console.log(`[delta] + table ${name}`);
            createdTables++;
        } else if (viewMatch) {
            const name = viewMatch[2];
            db.exec(`DROP VIEW IF EXISTS "${name}";`);
            db.exec(stmt + ';');
            recreatedViews.add(name);
            refreshedViews++;
        }
    }
    for (const v of preViews) {
        if (recreatedViews.has(v.name) || !v.sql) continue;
        try {
            db.exec(v.sql + ';');
            console.log(`[delta] = restored unmanaged view ${v.name}`);
            restoredViews++;
        } catch (err) {
            console.error(`[delta] ! could not restore unmanaged view ${v.name}: ${err.message}`);
            console.error(`[delta] ! original SQL was:\n${v.sql}`);
            console.error('[delta] ! aborting: the migration rolls back, nothing was changed.');
            throw err;
        }
    }
});
tx();
db.close();

console.log(`[delta] done: +${createdTables} tables, +${addedColumns} columns, ${rebuiltTables} rebuilt, ${refreshedViews} views refreshed, ${restoredViews} unmanaged views restored, ${reconciled} existing tables reconciled.`);
