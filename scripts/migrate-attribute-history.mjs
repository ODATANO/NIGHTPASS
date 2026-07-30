// Additive migration: creates the passport_PassportAttributeHistory table in
// the SQLite database from the current CDS model. Idempotent: skips if the
// table already exists. Touches no other table and no row, so it is safe on a
// database with live passports (we NEVER run cds.deploy against a live DB,
// that would drop and reseed everything).
//
// Run: node scripts/migrate-attribute-history.mjs   (server stopped; SQLite is single-writer)
// Then: node scripts/refresh-views.mjs              (so service projections see the entity)
//
// Postgres (server deploy): the production profile evolves the schema on boot;
// no manual step needed. If a manual run is ever required, compile the same
// statement with { dialect: 'postgres' } and execute it against the prod DB.
import cds from '@sap/cds';
import Database from 'better-sqlite3';

const DB = process.env.PASSPORT_DB || 'db/passport.db';
const TABLE = 'passport_PassportAttributeHistory';

await cds.plugins;
const model = cds.linked(await cds.load('*'));
const ddl = cds.compile.to.sql(model, { dialect: 'sqlite' });
const statements = (Array.isArray(ddl) ? ddl : String(ddl).split(';'))
    .map((s) => String(s).trim())
    .filter(Boolean);

const create = statements.find((s) => new RegExp(`^CREATE TABLE ${TABLE}\\b`, 'i').test(s));
if (!create) { console.error(`no CREATE TABLE ${TABLE} in the compiled DDL (schema not loaded?)`); process.exit(1); }

const db = new Database(DB);
const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
if (exists) {
    console.log(`${DB}: ${TABLE} already exists, nothing to do`);
    process.exit(0);
}
db.exec(create);
console.log(`${DB}: created ${TABLE}`);
console.log('next: node scripts/refresh-views.mjs');
