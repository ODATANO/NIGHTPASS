#!/usr/bin/env node --import tsx
// Read-only payload-hash parity check: recompute every anchored passport's
// canonical v2 payload from the DB rows and compare with the stored
// payloadHash; roundtrip the stored payloadCipher. Used as the regression
// gate around refactors of the hashing/cipher code path: the report must be
// IDENTICAL before and after (v1-anchored rows always report drift, that is
// the documented projection asymmetry, not an error).
//
// Usage:
//   node --import tsx scripts/verify-payload-hash-parity.mts [--db path] [--out report.txt]
//
// One-shot readonly connection (never keep this open while proving runs).
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// srv/lib compiles to CommonJS; named ESM imports don't resolve under tsx.
const require = createRequire(import.meta.url);
const { payloadFromDb } = require('../srv/lib/passport-payload');
const { hashPayload, decryptPayload } = require('../srv/lib/passport-anchor');

const ROOT = resolve(import.meta.dirname, '..');

// ENCRYPTION_KEY from the environment, falling back to .env (the cipher
// roundtrip needs the real key).
if (!process.env.ENCRYPTION_KEY && existsSync(resolve(ROOT, '.env'))) {
    for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
        const m = /^ENCRYPTION_KEY=(.+)$/.exec(line.trim());
        if (m) process.env.ENCRYPTION_KEY = m[1].trim();
    }
}

const args = process.argv.slice(2);
const argOf = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = argOf('--db') ?? resolve(ROOT, 'db/passport.db');
const outPath = argOf('--out');

const db = new Database(dbPath, { readonly: true });
const passports = db.prepare(
    `SELECT ID, passportId, payloadHash, payloadCipher FROM passport_Passports
     WHERE payloadHash IS NOT NULL AND payloadHash != '' ORDER BY passportId`
).all() as Array<{ ID: string; passportId: string; payloadHash: string; payloadCipher: Buffer | string | null }>;

// CAP's sqlite adapter stores LargeBinary as base64 TEXT.
const asBuffer = (v: Buffer | string | null): Buffer | null =>
    v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'base64');

const lines: string[] = [];
let matches = 0, drifts = 0, cipherFails = 0;

for (const p of passports) {
    const batteries = db.prepare(
        `SELECT serialNumber, cellChemistry, capacityKwh, carbonFootprintKgCO2, supplierName,
                recycledContentPct, cycleLife, roundTripEfficiencyPct, leadContentPpm
         FROM passport_Batteries WHERE passport_ID = ?`).all(p.ID) as Record<string, unknown>[];
    const recycledMaterials = db.prepare(
        `SELECT material, recycledPercentage, sourceSupplierName
         FROM passport_RecycledMaterials WHERE passport_ID = ?`).all(p.ID) as Record<string, unknown>[];
    const diligenceDocs = db.prepare(
        `SELECT docType, fileName, sha256 FROM passport_DiligenceDoc WHERE passport_ID = ?`
    ).all(p.ID) as Record<string, unknown>[];
    const attributes = db.prepare(
        `SELECT section, attribute, valueJson, accessClass
         FROM passport_PassportAttributes WHERE passport_ID = ?`).all(p.ID) as Record<string, unknown>[];

    const { payloadHash } = hashPayload(payloadFromDb({ batteries, recycledMaterials, diligenceDocs, attributes }));
    const hashState = payloadHash === p.payloadHash ? 'match' : 'drift';
    if (hashState === 'match') matches++; else drifts++;

    let cipherState = 'no-cipher';
    const cipherBuf = asBuffer(p.payloadCipher);
    if (cipherBuf && cipherBuf.length > 0) {
        try {
            decryptPayload(cipherBuf, p.passportId);
            cipherState = 'cipher-ok';
        } catch {
            cipherState = 'cipher-FAIL';
            cipherFails++;
        }
    }
    lines.push(`${p.passportId}\t${hashState}\t${cipherState}`);
}
db.close();

const report = [
    ...lines,
    `# passports=${passports.length} match=${matches} drift=${drifts} cipherFails=${cipherFails}`,
].join('\n');
console.log(report);
if (outPath) writeFileSync(outPath, report + '\n');
