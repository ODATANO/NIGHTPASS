#!/usr/bin/env node
// Bake a sanitized copy of the live database for the public demo host:
// drops runtime wallet state (sync blobs, sessions) and the DPP conformance
// store, keeps the demo passports. Output: deploy/passport-demo.db
// Usage: node scripts/bake-demo-db.mjs
import Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'deploy/passport-demo.db');
mkdirSync(resolve(ROOT, 'deploy'), { recursive: true });
rmSync(OUT, { force: true });
// SQLite online backup, NOT a file copy: the live DB runs in WAL mode and a
// plain copy silently loses everything still sitting in the -wal file.
const src = new Database(resolve(ROOT, 'db/passport.db'), { readonly: true });
await src.backup(OUT);
src.close();

const db = new Database(OUT);
db.pragma('busy_timeout = 10000');
const WIPE = ['midnight_WalletSyncStates', 'midnight_WalletSessions', 'passport_DppDocuments'];
for (const t of WIPE) {
    try { console.log(`${t}: -${db.prepare(`DELETE FROM ${t}`).run().changes} rows`); }
    catch (e) { console.log(`${t}: skipped (${e.message})`); }
}
db.exec('VACUUM');
const rows = db.prepare('SELECT passportId, status, anchorNetwork FROM passport_Passports ORDER BY createdAt').all();
db.close();
console.log(`\nbaked ${OUT} with ${rows.length} passports:`);
for (const r of rows) console.log(` - ${r.passportId} (${r.status}, ${r.anchorNetwork})`);
console.log('\nShip it into the volume BEFORE first start:');
console.log('  docker compose -f deploy/docker-compose.yml run --rm -v $(pwd)/deploy:/src --entrypoint cp nightpass /src/passport-demo.db /data/passport.db');
