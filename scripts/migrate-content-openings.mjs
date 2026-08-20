// Additive migration for the salted content tree (NIGHTGATE 0.16.x): adds the
// content-tree coordinates to passport_Passports and to the archived versions
// in passport_PassportAnchorVersions.
//
//   Passports:            contentRoot, contentSchemaId, contentSaltSeed
//   PassportAnchorVersions: contentRoot exists already; adds
//                         contentSchemaId, contentSaltSeed
//
// Why the seed is a schema column and not a runtime detail: since 0.16.0 every
// content-tree leaf is salted with slotSalt(seed, slotIndex). The seed is the
// OPENING of the anchored root. Without it the root cannot be rebuilt, so no
// claim on that passport can ever be proven again; with it published, the
// shared leaf hashes we hand out along inclusion paths become guessable again.
// It therefore lives in the base table and is excluded from every service
// projection.
//
// Idempotent: each column is skipped when already present. Touches no row (we
// NEVER run cds.deploy against a live DB, that would drop and reseed).
//
// Run: node scripts/migrate-content-openings.mjs   (server STOPPED; SQLite is single-writer)
// Then: node scripts/refresh-views.mjs             (AFTER all model work; a view
//                                                   refreshed too early misses
//                                                   later projections)
//
// Postgres (server deploy): the production profile evolves the schema on boot.
import Database from 'better-sqlite3';

const DB = process.env.PASSPORT_DB || 'db/passport.db';

/** table -> columns to add, with their SQLite type. */
const PLAN = {
    passport_Passports: {
        contentRoot: 'NVARCHAR(64)',
        contentSchemaId: 'NVARCHAR(64)',
        contentSaltSeed: 'NVARCHAR(64)'
    },
    passport_PassportAnchorVersions: {
        contentSchemaId: 'NVARCHAR(64)',
        contentSaltSeed: 'NVARCHAR(64)'
    },
    // Cross-root claims (predicate = documentIntegrity) relate TWO versions, so
    // the log needs the second document and the mask that was proven.
    passport_PredicateProofLog: {
        payloadHashB: 'NVARCHAR(64)',
        allowedMask: 'INTEGER'
    }
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
            if (present.has(column)) {
                console.log(`${DB}: ${table}.${column} already exists, skipping`);
                continue;
            }
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
            console.log(`${DB}: added ${table}.${column}`);
            added++;
        }
    }
    db.exec('COMMIT');
} catch (e) {
    db.exec('ROLLBACK');
    console.error('migration failed, rolled back:', e.message);
    process.exit(1);
} finally {
    db.close();
}

console.log(added ? `done: ${added} column(s) added` : 'done: nothing to do');
console.log('reminder: rows anchored before this release carry NULL seeds. Their anchored');
console.log('content root cannot be rebuilt, so they must be re-anchored before new claims.');
