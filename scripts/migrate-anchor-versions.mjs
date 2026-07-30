// Additive migration for the re-anchoring feature: creates the
// passport_PassportAnchorVersions table and adds the payloadHash column to
// passport_PredicateProofLog. Idempotent: each step is skipped when already
// applied. Touches no other table and no row (we NEVER run cds.deploy against
// a live DB, that would drop and reseed everything).
//
// Run: node scripts/migrate-anchor-versions.mjs   (server stopped; SQLite is single-writer)
// Then: node scripts/refresh-views.mjs            (AFTER all service projections exist
//                                                  in the model; a view refreshed too
//                                                  early misses later projections)
//
// Postgres (server deploy): the production profile evolves the schema on boot;
// no manual step needed.
import cds from '@sap/cds';
import Database from 'better-sqlite3';

const DB = process.env.PASSPORT_DB || 'db/passport.db';
const TABLE = 'passport_PassportAnchorVersions';
const PROOF_TABLE = 'passport_PredicateProofLog';
const PROOF_COLUMN = 'payloadHash';

await cds.plugins;
const model = cds.linked(await cds.load('*'));
const ddl = cds.compile.to.sql(model, { dialect: 'sqlite' });
const statements = (Array.isArray(ddl) ? ddl : String(ddl).split(';'))
    .map((s) => String(s).trim())
    .filter(Boolean);

const create = statements.find((s) => new RegExp(`^CREATE TABLE ${TABLE}\\b`, 'i').test(s));
if (!create) { console.error(`no CREATE TABLE ${TABLE} in the compiled DDL (schema not loaded?)`); process.exit(1); }

const db = new Database(DB);

const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
if (tableExists) {
    console.log(`${DB}: ${TABLE} already exists, skipping`);
} else {
    db.exec(create);
    console.log(`${DB}: created ${TABLE}`);
}

const proofColumns = db.prepare(`PRAGMA table_info(${PROOF_TABLE})`).all().map((c) => c.name);
if (proofColumns.includes(PROOF_COLUMN)) {
    console.log(`${DB}: ${PROOF_TABLE}.${PROOF_COLUMN} already exists, skipping`);
} else {
    db.exec(`ALTER TABLE ${PROOF_TABLE} ADD COLUMN ${PROOF_COLUMN} NVARCHAR(64)`);
    console.log(`${DB}: added ${PROOF_TABLE}.${PROOF_COLUMN}`);
}

console.log('next (after ALL model work is done): node scripts/refresh-views.mjs');
