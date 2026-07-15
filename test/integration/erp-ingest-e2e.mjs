// ERP ingest e2e against a RUNNING NIGHTPASS server:
//
//   mock-SAP goods-receipt -> CloudEvent -> HMAC-signed webhook
//   POST /api/v1/passport/erp-events -> createPassport (auto-anchor when
//   ERP_AUTO_ANCHOR=true on the server) -> poll row -> verifyAttestationState.
//
//   npm start                                  (terminal 1, cds-tsx serve)
//   node --env-file=.env test/integration/erp-ingest-e2e.mjs   (terminal 2)
//
// Env knobs:
//   NIGHTPASS_BASE       default http://localhost:4004
//   ERP_WEBHOOK_SECRET   required (same value the SERVER runs with)
//   ERP_EXPECT_ANCHOR    default '1'; set '0' when the server runs without
//                        ERP_AUTO_ANCHOR (asserts the offline-draft path only)

import { Agent, setGlobalDispatcher } from 'undici';
import crypto from 'node:crypto';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const SECRET = process.env.ERP_WEBHOOK_SECRET;
const EXPECT_ANCHOR = (process.env.ERP_EXPECT_ANCHOR ?? '1') === '1';
const POLL_MS = 5000;
const AUTH = 'Basic ' + Buffer.from('producer:producer').toString('base64');

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!SECRET) fail('ERP_WEBHOOK_SECRET env var is required (run with node --env-file=.env)');

async function post(path, body, headers = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

async function get(path) {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: AUTH } });
    if (!r.ok) fail(`GET ${path} -> ${r.status}: ${await r.text()}`);
    return r.json();
}

// --- 1. Emit a fresh goods-receipt from the mock ERP feed -------------------
step('MockSap triggerGoodsReceipt(1)');
const trig = await post('/api/v1/mock-sap/triggerGoodsReceipt', { count: 1 });
if (trig.status !== 200) fail(`triggerGoodsReceipt -> ${trig.status}: ${pretty(trig.body)}`);
const emitted = trig.body?.value?.[0] ?? trig.body?.[0];
if (!emitted?.batchId) fail(`no batchId in response: ${pretty(trig.body)}`);
console.log(`OK   emitted batch ${emitted.batchId} / passport ${emitted.passportId}`);

const feed = await get(`/api/v1/mock-sap/GoodsReceipts?$filter=batchId eq '${emitted.batchId}'`);
const receipt = feed.value?.[0];
if (!receipt?.payloadJson) fail('goods-receipt row has no payloadJson');
// createPassport expects the FLAT PassportInput shape: passportId + the public
// Annex-XIII point-1 fields + the private arrays from payloadJson.
const payload = {
    passportId: receipt.passportId,
    manufacturerId: receipt.manufacturerId,
    batteryCategory: receipt.batteryCategory,
    model: receipt.model,
    manufactureDate: receipt.manufactureDate,
    weightKg: receipt.weightKg,
    performanceClass: receipt.performanceClass,
    ...JSON.parse(receipt.payloadJson)
};

// --- 2. Wrap in the EQUINOX CloudEvent and HMAC-sign the raw body -----------
step('POST signed CloudEvent to /api/v1/passport/erp-events');
const event = {
    specversion: '1.0',
    id: crypto.randomUUID(),
    source: 'urn:odatano:equinox:mock-sap',
    type: 'com.odatano.equinox.goodsreceipt.created',
    time: new Date().toISOString(),
    data: payload
};
const raw = JSON.stringify(event);
const signature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(Buffer.from(raw)).digest('hex');

// negative probe first: a bad signature must be rejected
const bad = await post('/api/v1/passport/erp-events', raw, { 'x-equinox-signature': 'sha256=' + '0'.repeat(64) });
if (bad.status !== 401) fail(`bad signature should give 401, got ${bad.status}`);
console.log('OK   invalid signature rejected (401)');

const res = await post('/api/v1/passport/erp-events', raw, { 'x-equinox-signature': signature });
if (res.status !== 201) fail(`erp-events -> ${res.status}: ${pretty(res.body)}`);
console.log(`OK   ingested: ${pretty(res.body)}`);
const passportId = res.body.passportId;

// duplicate probe: the same event again must be idempotent
const dup = await post('/api/v1/passport/erp-events', raw, { 'x-equinox-signature': signature });
if (dup.status !== 200 || dup.body?.status !== 'duplicate') {
    fail(`duplicate event should give 200/duplicate, got ${dup.status}: ${pretty(dup.body)}`);
}
console.log('OK   duplicate event idempotent (200)');

// --- 3. Poll the passport row --------------------------------------------
if (!EXPECT_ANCHOR) {
    const row = (await get(`/api/v1/producer/Passports?$filter=passportId eq '${passportId}'&$select=passportId,status`)).value?.[0];
    if (!row) fail('passport row not found');
    console.log(`\nERP INGEST PASSED (offline draft). Passport ${passportId}, status=${row.status}`);
    process.exit(0);
}

step('Poll passport row until anchored (attest + bindPassport + contentRoot)');
const rowUrl = `/api/v1/producer/Passports?$filter=passportId eq '${passportId}'&$select=ID,passportId,status,attestationTxHash,payloadHash,contractAddress`;
const deadline = Date.now() + 20 * 60_000;
let row = null, lastStatus = null;
while (Date.now() < deadline) {
    row = (await get(rowUrl)).value?.[0];
    const status = row?.status ?? '(no row yet)';
    if (status !== lastStatus) { process.stdout.write(`\n     [anchor] status=${status}`); lastStatus = status; }
    else process.stdout.write('.');
    if (status === 'anchored' || status === 'failed') break;
    await new Promise(r2 => setTimeout(r2, POLL_MS));
}
process.stdout.write('\n');
if (!row) fail('passport row not found after ingest');
if (row.status !== 'anchored') fail(`passport status is '${row.status}' (expected 'anchored')`);

step('Transaction log');
const txs = await get(`/api/v1/producer/PassportTransactions?$filter=passport_ID eq ${row.ID}&$select=kind,status,txHash,errorMessage`);
for (const t of txs.value ?? []) console.log(`  tx: ${t.kind.padEnd(18)} ${t.status.padEnd(10)} ${t.txHash ?? t.errorMessage ?? ''}`);

step('Crawler-free on-chain confirm: verifyAttestationState');
const v = await get(`/api/v1/nightgate/verifyAttestationState(contractAddress='${row.contractAddress}',payloadHash='${row.payloadHash}',compiledArtifactRef='attestation-vault')`);
console.log(`verifyAttestationState -> ${pretty(v)}`);
if (v?.verified !== true) fail('on-chain state did NOT confirm the attested payload hash');

console.log(`\nERP INGEST E2E PASSED. Goods-receipt ${emitted.batchId} -> passport ${passportId} anchored on-chain.`);
console.log(`Attest tx: ${row.attestationTxHash}`);
