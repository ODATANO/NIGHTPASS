#!/usr/bin/env node
// Point all passports' qrCodeUrl at the real public host (run once the demo
// domain exists). Safe for anchored rows: qrCodeUrl is Point-1 metadata and
// NOT part of the anchored payload hash.
// Usage: node scripts/set-qr-host.mjs https://passport.example.org [dbPath]
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const host = String(process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(host)) {
    console.error('usage: node scripts/set-qr-host.mjs https://<demo-host> [dbPath]');
    process.exit(1);
}
const dbPath = process.argv[3] ?? resolve(import.meta.dirname, '../db/passport.db');
const db = new Database(dbPath);
db.pragma('busy_timeout = 10000');
const rows = db.prepare('SELECT ID, passportId FROM passport_Passports').all();
const upd = db.prepare('UPDATE passport_Passports SET qrCodeUrl = ? WHERE ID = ?');
const tx = db.transaction(() => {
    for (const r of rows) upd.run(`${host}/p/${r.passportId}`, r.ID);
});
tx();
console.log(`updated qrCodeUrl for ${rows.length} passports in ${dbPath} -> ${host}/p/<id>`);
