// Additive migration for ZK set-membership claims: adds the setRoot and setId
// columns to passport_PredicateProofLog. Idempotent: each step is skipped when
// already applied. Touches no other table and no row (we NEVER run cds.deploy
// against a live DB, that would drop and reseed everything).
//
// Run: node scripts/migrate-membership-claims.mjs  (server stopped; SQLite is single-writer)
// Then: node scripts/refresh-views.mjs             (AFTER all service projections exist
//                                                   in the model; a view refreshed too
//                                                   early misses later projections)
//
// Postgres (server deploy): the production profile evolves the schema on boot;
// no manual step needed.
import Database from 'better-sqlite3';

const DB = process.env.PASSPORT_DB || 'db/passport.db';
const TABLE = 'passport_PredicateProofLog';
const COLUMNS = [
    { name: 'setRoot', ddl: 'NVARCHAR(64)' },
    { name: 'setId', ddl: 'NVARCHAR(60)' },
];

const db = new Database(DB);
const have = db.prepare(`PRAGMA table_info(${TABLE})`).all().map((c) => c.name);
for (const col of COLUMNS) {
    if (have.includes(col.name)) {
        console.log(`${DB}: ${TABLE}.${col.name} already exists, skipping`);
        continue;
    }
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col.name} ${col.ddl}`);
    console.log(`${DB}: added ${TABLE}.${col.name}`);
}
db.close();
console.log('next (after ALL model work is done): node scripts/refresh-views.mjs');
