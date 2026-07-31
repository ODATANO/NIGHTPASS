// S/4 bridge e2e against a RUNNING NIGHTPASS server (chain-free):
//
//   mock S/4 (in-process http server, API_MATERIAL_DOCUMENT_SRV V2 shape)
//   -> scripts/s4-bridge.mts --once -> HMAC CloudEvent -> /erp-events
//   -> passport row (offline draft). Asserts the mapping, the movement-type
//   and product-master filters, the seen-state (second run posts nothing)
//   and the webhook idempotency (fresh state -> duplicate, no second row).
//
//   Server (scratch DB recommended, ERP_AUTO_ANCHOR unset = offline drafts):
//     cds_requires_db_credentials_database=<scratch> ERP_WEBHOOK_SECRET=<s> npm start
//   Then: ERP_WEBHOOK_SECRET=<s> node test/integration/s4-bridge-e2e.mjs
//
// Env knobs:
//   NIGHTPASS_BASE       default http://localhost:4004
//   ERP_WEBHOOK_SECRET   required (same value the SERVER runs with)

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const SECRET = process.env.ERP_WEBHOOK_SECRET;
const PRODUCER = 'Basic ' + Buffer.from('producer:producer').toString('base64');

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
const q = (s) => encodeURIComponent(`'${String(s).replace(/'/g, "''")}'`);

if (!SECRET) fail('ERP_WEBHOOK_SECRET env var is required (run with node --env-file=.env)');

async function odata(path_) {
    const r = await fetch(`${BASE}${path_}`, { headers: { Authorization: PRODUCER } });
    if (!r.ok) fail(`GET ${path_} -> ${r.status}: ${await r.text()}`);
    return r.json();
}
const rowFor = async (pid) =>
    (await odata(`/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=passportId,status,model,manufacturerId,manufactureDate`)).value?.[0];

// --- 1. Mock S/4: API_MATERIAL_DOCUMENT_SRV with a V2 d.results envelope ----
const FIXTURE = {
    d: {
        results: [
            {
                MaterialDocumentYear: '2026', MaterialDocument: '4900000001',
                PostingDate: '/Date(1753833600000)/',
                to_MaterialDocumentItem: {
                    results: [
                        { MaterialDocumentYear: '2026', MaterialDocument: '4900000001', MaterialDocumentItem: '0001', Material: 'EV-BATTERY-75', Plant: '1010', Batch: 'CH-2026-07A', GoodsMovementType: '101', QuantityInEntryUnit: '1.000', EntryUnit: 'PC' },
                        { MaterialDocumentYear: '2026', MaterialDocument: '4900000001', MaterialDocumentItem: '0002', Material: 'PACKAGING-FOIL', GoodsMovementType: '101', QuantityInEntryUnit: '400.000', EntryUnit: 'M' },
                        { MaterialDocumentYear: '2026', MaterialDocument: '4900000001', MaterialDocumentItem: '0003', Material: 'EV-BATTERY-75', GoodsMovementType: '561', QuantityInEntryUnit: '1.000' }
                    ]
                }
            },
            {
                MaterialDocumentYear: '2026', MaterialDocument: '4900000002',
                PostingDate: '/Date(1753920000000)/',
                to_MaterialDocumentItem: {
                    results: [
                        { MaterialDocumentYear: '2026', MaterialDocument: '4900000002', MaterialDocumentItem: '0001', Material: 'EV-BATTERY-75', GoodsMovementType: '101', GoodsMovementIsCancelled: true }
                    ]
                }
            }
        ]
    }
};

step('Start mock S/4 server');
let s4Requests = 0;
const mock = http.createServer((req, res) => {
    if (!req.url.includes('/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader')) {
        res.writeHead(404); return res.end('not found');
    }
    s4Requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(FIXTURE));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const s4Base = `http://127.0.0.1:${mock.address().port}`;
console.log(`OK   mock S/4 at ${s4Base}`);

// --- 2. Run the bridge (--once) against the running NIGHTPASS ---------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4-bridge-e2e-'));
const stateFile = path.join(tmp, 'state.json');

// spawn (async), NOT spawnSync: the mock S/4 server lives in THIS process,
// a blocked event loop could never answer the bridge's poll.
function runBridge(label) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/s4-bridge.mts', '--once'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                S4_BASE_URL: s4Base,
                S4_PRODUCT_MASTER: 'config/s4-product-master.example.json',
                S4_STATE_FILE: stateFile,
                NIGHTPASS_BASE: BASE,
                ERP_WEBHOOK_SECRET: SECRET
            },
            timeout: 180_000
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => {
            console.log(out.trim().split('\n').map(l => `     ${l}`).join('\n'));
            if (code !== 0) fail(`${label}: bridge exited ${code}\n${err}`);
            resolve(out);
        });
    });
}

step('Bridge run 1: fresh state');
const out1 = await runBridge('run 1');
if (!/2 receipt items, 1 posted, 1 non-battery skipped/.test(out1)) {
    fail(`run 1 expected '2 receipt items, 1 posted, 1 non-battery skipped' in output`);
}

const PID = 'BAT-EVBATTERY75-49000000010001';
const row = await rowFor(PID);
if (!row) fail(`passport ${PID} not created`);
if (row.status !== 'draft') fail(`expected offline draft, got status '${row.status}'`);
if (row.model !== 'PowerCell EV-75' || row.manufacturerId !== 'DE-CELLCO-001') fail(`mapped fields wrong: ${JSON.stringify(row)}`);
if (String(row.manufactureDate).slice(0, 10) !== '2025-07-30') fail(`manufactureDate wrong: ${row.manufactureDate}`);
console.log(`OK   ${PID} created as offline draft with mapped fields`);

// filters: the foil item and the 561/cancelled items must NOT create rows
for (const ghost of ['BAT-PACKAGINGFOIL-49000000010002', 'BAT-EVBATTERY75-49000000010003', 'BAT-EVBATTERY75-49000000020001']) {
    if (await rowFor(ghost)) fail(`filtered item leaked into a passport row: ${ghost}`);
}
console.log('OK   non-battery, non-101 and cancelled items filtered');

// --- 3. Bridge run 2: seen-state suppresses re-posting ----------------------
step('Bridge run 2: seen state');
const out2 = await runBridge('run 2');
if (!/2 receipt items, 0 posted/.test(out2)) fail('run 2 should post nothing (seen state)');
console.log('OK   second cycle posts nothing');

// --- 4. Fresh state: webhook idempotency catches the replay -----------------
step('Bridge run 3: fresh state, webhook must answer duplicate');
fs.rmSync(stateFile);
const out3 = await runBridge('run 3');
if (!new RegExp(`${PID}: duplicate`).test(out3)) fail('run 3 should hit the duplicate path');
const count = (await odata(`/api/v1/producer/Passports?$filter=passportId eq ${q(PID)}&$select=ID`)).value?.length;
if (count !== 1) fail(`expected exactly 1 row for ${PID}, got ${count}`);
console.log('OK   webhook idempotency: still exactly one row');

mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (s4Requests < 3) fail(`mock S/4 was only hit ${s4Requests} times`);
console.log(`\nS4 BRIDGE E2E PASSED. Goods receipt 4900000001/0001 -> ${PID} (offline draft), filters + idempotency verified.`);
