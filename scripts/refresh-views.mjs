// Recreates the service VIEWS in the SQLite database from the current CDS model.
//
// Service projections are SQL views over the base tables. When a column is added
// to a base table with `ALTER TABLE ADD COLUMN` (the additive migration path we
// use so live passports/grants survive), the views keep their OLD column list,
// so the new column is invisible to every OData read on that projection
// ("no such column: $P.<col>"). This script drops and recreates just the views;
// it touches no table and no row, so it is safe to run against a live database.
//
// Run: node scripts/refresh-views.mjs   (server stopped; SQLite is single-writer)
import cds from '@sap/cds';
import Database from 'better-sqlite3';

const DB = process.env.PASSPORT_DB || 'db/passport.db';

await cds.plugins;
const model = cds.linked(await cds.load('*'));
const ddl = cds.compile.to.sql(model, { dialect: 'sqlite' });
const statements = (Array.isArray(ddl) ? ddl : String(ddl).split(';'))
    .map((s) => String(s).trim())
    .filter(Boolean);

const createViews = statements.filter((s) => /^CREATE VIEW/i.test(s));
if (!createViews.length) { console.error('no CREATE VIEW statements in the compiled DDL'); process.exit(1); }

const db = new Database(DB);
const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map((r) => r.name);

let dropped = 0, created = 0;
db.exec('BEGIN');
try {
    for (const name of existing) { db.exec(`DROP VIEW IF EXISTS "${name}"`); dropped++; }
    for (const stmt of createViews) { db.exec(stmt); created++; }
    db.exec('COMMIT');
} catch (e) {
    db.exec('ROLLBACK');
    console.error('failed, rolled back:', e.message);
    process.exit(1);
}
console.log(`${DB}: dropped ${dropped} view(s), recreated ${created} from the current model`);
