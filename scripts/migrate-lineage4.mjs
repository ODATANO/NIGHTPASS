// Additive migration for vault lineage 4 (NIGHTGATE 0.24): records are keyed
// by (attester, payload), so every anchored version and every claim carries
// the attester that anchored it, and claims carry their on-chain expiry.
//
//   Passports:              attesterId
//   PassportAnchorVersions: attesterId
//   PredicateProofLog:      attesterId, validUntil
//
// Idempotent: each column is skipped when already present. Touches no row
// (never cds.deploy against a live DB, that would drop and reseed). Rows
// anchored before lineage 4 keep a null attesterId; the state reads then
// resolve the record through the bound document id, which only the CURRENT
// version has.
//
// Run: node scripts/migrate-lineage4.mjs   (server STOPPED; SQLite is single-writer)
// Then: node scripts/refresh-views.mjs
// Postgres (server deploy): the production profile evolves the schema on boot.
import Database from 'better-sqlite3';

const DB = process.env.PASSPORT_DB || 'db/passport.db';

const PLAN = {
    passport_Passports: { attesterId: 'NVARCHAR(64)' },
    passport_PassportAnchorVersions: { attesterId: 'NVARCHAR(64)' },
    passport_PredicateProofLog: { attesterId: 'NVARCHAR(64)', validUntil: 'TIMESTAMP_TEXT' }
};

const db = new Database(DB);
let added = 0;
try {
    db.exec('BEGIN');
    for (const [table, columns] of Object.entries(PLAN)) {
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!exists) {
            console.log(`${DB}: ${table} does not exist, skipping (run the earlier migrations first)`);
            continue;
        }
        const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
        for (const [column, type] of Object.entries(columns)) {
            if (present.has(column)) { console.log(`${table}.${column}: present`); continue; }
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
            console.log(`${table}.${column}: added`);
            added++;
        }
    }
    db.exec('COMMIT');
} catch (e) {
    db.exec('ROLLBACK');
    throw e;
} finally {
    db.close();
}
console.log(`${DB}: ${added} column(s) added`);
