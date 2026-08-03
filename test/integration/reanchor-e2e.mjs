// Re-anchoring e2e against a RUNNING NIGHTPASS server with a funded server
// wallet (npm run start:wallets + PASSPORT_CONTRACT_ADDRESS):
//
//   create passport (submit:true, LMT) -> anchored v1 -> optional ZK proof ->
//   2 BMS telemetry ticks -> drift detected -> reanchorPassport ->
//   anchored v2 -> BOTH versions verify live on-chain; the old hash resolves;
//   the old claim still verifies (stamped hash).
//
//   node test/integration/reanchor-e2e.mjs
//
// Env knobs:
//   NIGHTPASS_BASE   default http://localhost:4004
//   WALLET_ID        server wallet that signs (default 'default' = Main)
//   SKIP_PROOF       '1' skips the ZK-claim leg (saves ~5 min wasm proving)
//
// Spends a handful of testnet transactions (fee-sponsored when
// PASSPORT_FEE_SPONSOR_WALLET is set on the server).

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const WALLET_ID = process.env.WALLET_ID || 'default';
const SKIP_PROOF = process.env.SKIP_PROOF === '1';
const AUTH = 'Basic ' + Buffer.from('producer:producer').toString('base64');
const POLL_MS = 10_000;

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }
const q = (s) => encodeURIComponent(`'${String(s).replace(/'/g, "''")}'`);
const short = (h) => String(h ?? '').slice(0, 12) + '...';

async function get(path, { anon } = {}) {
    const r = await fetch(`${BASE}${path}`, { headers: anon ? {} : { Authorization: AUTH }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) fail(`GET ${path} -> ${r.status}: ${await r.text()}`);
    return r.json();
}
async function post(path, body) {
    const r = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: AUTH },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120_000)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}
async function pollStatus(pid, want, minutes) {
    const deadline = Date.now() + minutes * 60_000;
    let last = null;
    while (Date.now() < deadline) {
        const row = (await get(`/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=status,payloadHash,attestationTxHash`)).value?.[0];
        const s = row?.status ?? '(none)';
        if (s !== last) { process.stdout.write(`\n     [${pid}] status=${s}`); last = s; } else process.stdout.write('.');
        if (s === want) { process.stdout.write('\n'); return row; }
        if (s === 'failed') fail(`${pid} went to 'failed' (see Transactions tab)`);
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
    fail(`${pid} did not reach '${want}' in ${minutes} min`);
}

// --- 0. Prewarm the signing wallet ------------------------------------------
// Same flow as the cockpit login: open the session + facade prewarm first,
// so createPassport(submit:true) does not race a cold wallet worker (a cold
// session open can lose the write lock to the sync-state saves and the
// passport would land as an offline draft).
step(`Prewarm server wallet '${WALLET_ID}'`);
const warm = await post('/api/v1/producer/prewarmServerWallet', { walletId: WALLET_ID });
if (warm.status !== 200) fail(`prewarmServerWallet -> ${warm.status}: ${pretty(warm.body)}`);
{
    const deadline = Date.now() + 20 * 60_000;
    let state = warm.body?.state;
    while (state !== 'ready' && Date.now() < deadline) {
        if (state === 'error') fail(`wallet prewarm error: ${pretty(warm.body)}`);
        await new Promise((r) => setTimeout(r, POLL_MS));
        const s = await get(`/api/v1/producer/serverWalletStatus(walletId=${q(WALLET_ID)})`);
        state = s.state;
        if (s.state === 'error') fail(`wallet prewarm error: ${s.error}`);
        process.stdout.write('.');
    }
    if (state !== 'ready') fail('wallet prewarm did not finish in 20 min');
}
console.log(`\nOK   wallet '${WALLET_ID}' at chain tip`);

// --- 1. Create + anchor v1 ---------------------------------------------------
step('Create passport + anchor v1');
const pid = `BAT-REANCHOR-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const created = await post('/api/v1/producer/createPassport', {
    passportJson: JSON.stringify({
        passportId: pid, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'LMT',
        model: 'CityCharge LMT-15', manufactureDate: '2026-06-01', weightKg: 12.5, performanceClass: 'B',
        batteries: [{ serialNumber: `SN-${pid}`, cellChemistry: 'LFP', capacityKwh: 1.2, carbonFootprintKgCO2: 88, supplierName: 'CellCraft AB' }],
        recycledMaterials: [{ material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt Recyclers SA' }]
    }),
    submit: true, walletId: WALLET_ID
});
if (created.status !== 200 || created.body?.mode !== 'anchoring') fail(`createPassport -> ${created.status}: ${pretty(created.body)}`);
console.log(`OK   ${pid} anchoring (v1 hash ${short(created.body.payloadHash)})`);
const v1 = await pollStatus(pid, 'anchored', 25);
const v1Hash = v1.payloadHash;
console.log(`OK   v1 anchored: ${short(v1Hash)} tx ${short(v1.attestationTxHash)}`);

// --- 2. Optional: prove one ZK claim under v1 --------------------------------
let claim = null;
if (!SKIP_PROOF) {
    step('Prove CF claim under v1');
    const prove = await post('/api/v1/producer/provePassportValue', {
        passportId: pid, sourceField: 'carbonFootprintKgCO2', predicate: 'lessOrEqual',
        threshold: 4000, unit: 'kg CO2e', walletId: WALLET_ID
    });
    if (prove.status !== 200 || prove.body?.mode !== 'proving') fail(`provePassportValue -> ${prove.status}: ${pretty(prove.body)}`);
    const proofLogId = prove.body.proofLogId;
    const deadline = Date.now() + 15 * 60_000;
    let proofRow = null;
    while (Date.now() < deadline) {
        proofRow = await get(`/api/v1/producer/PredicateProofLog(${proofLogId})`);
        if (proofRow.status === 'succeeded') break;
        if (proofRow.status === 'failed') fail('ZK proof failed');
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (proofRow?.status !== 'succeeded') fail('ZK proof did not finish in 15 min');
    if (proofRow.payloadHash !== v1Hash) fail(`proof row not stamped with v1 hash: ${proofRow.payloadHash}`);
    claim = { sourceField: 'carbonFootprintKgCO2', predicate: 'lessOrEqual', threshold: 4000 };
    console.log(`\nOK   claim proven + stamped with v1 hash (tx ${short(proofRow.txHash)})`);
}

// --- 3. Telemetry drift ------------------------------------------------------
step('2 BMS telemetry ticks + drift check');
const sim = await post('/api/v1/bms-sim/triggerBmsTelemetry', { passportId: pid, ticks: 2 });
if (sim.status !== 200 || !(sim.body?.updated > 0)) fail(`triggerBmsTelemetry -> ${sim.status}: ${pretty(sim.body)}`);
console.log(`OK   ${sim.body.updated} attribute updates over ${sim.body.ticksApplied} ticks`);
const drift = await get(`/api/v1/producer/passportDrift(passportId=${q(pid)})`);
if (drift.drifted !== true) fail(`expected drift, got ${pretty(drift)}`);
console.log(`OK   drift detected (${short(drift.currentHash)} -> ${short(drift.recomputedHash)})`);

// --- 4. Re-anchor ------------------------------------------------------------
step('reanchorPassport');
const re = await post('/api/v1/producer/reanchorPassport', { passportId: pid, reason: 'batch-telemetry', walletId: WALLET_ID });
if (re.status !== 200 || re.body?.mode !== 'anchoring') fail(`reanchorPassport -> ${re.status}: ${pretty(re.body)}`);
if (re.body.archivedVersion !== 1) fail(`expected archivedVersion 1, got ${re.body.archivedVersion}`);
if (re.body.previousPayloadHash !== v1Hash) fail('previousPayloadHash mismatch');
if (re.body.payloadHash === v1Hash) fail('new hash equals old hash');
console.log(`OK   v1 archived, anchoring v2 (${short(re.body.payloadHash)})`);
const v2 = await pollStatus(pid, 'anchored', 25);
const v2Hash = v2.payloadHash;
if (v2Hash !== re.body.payloadHash) fail('row hash is not the re-anchored hash');
console.log(`OK   v2 anchored: ${short(v2Hash)} tx ${short(v2.attestationTxHash)}`);

// unchanged content must now be rejected
const again = await post('/api/v1/producer/reanchorPassport', { passportId: pid, reason: 'batch-telemetry', walletId: WALLET_ID });
if (again.status !== 400) fail(`unchanged re-anchor should give 400, got ${again.status}`);
console.log('OK   unchanged content rejected (400)');

// --- 5. Both versions verifiable --------------------------------------------
step('anchorHistory + per-version live verification');
const history = await get(`/api/v1/passport/anchorHistory(passportId=${q(pid)})`, { anon: true });
const entries = history.value ?? history;
if (!Array.isArray(entries) || entries.length !== 2) fail(`expected 2 history entries, got ${pretty(entries)}`);
if (entries[0].version !== 1 || entries[0].current !== false || entries[0].payloadHash !== v1Hash) fail(`v1 entry wrong: ${pretty(entries[0])}`);
if (entries[1].current !== true || entries[1].payloadHash !== v2Hash) fail(`current entry wrong: ${pretty(entries[1])}`);
console.log('OK   anchorHistory: v1 superseded (reason ' + entries[0].reason + ') + current');

const vNew = await get(`/api/v1/passport/verifyOnChain(passportId=${q(pid)})`, { anon: true });
if (vNew.verified !== true) fail(`current anchor did not verify: ${pretty(vNew)}`);
console.log(`OK   CURRENT version live-verified on ${vNew.checkedNetwork}`);

const vOld = await get(`/api/v1/passport/verifyAnchorVersion(passportId=${q(pid)},version=1)`, { anon: true });
if (vOld.verified !== true) fail(`OLD version did not verify: ${pretty(vOld)}`);
if (vOld.payloadHash !== v1Hash) fail('old-version check used the wrong hash');
console.log(`OK   SUPERSEDED v1 live-verified on ${vOld.checkedNetwork} (old hash still attested)`);

const resolved = await get(`/api/v1/passport/resolveByHash(payloadHash=${q(v1Hash)})`, { anon: true });
if (resolved.passportId !== pid || resolved.version !== 1) fail(`old hash did not resolve to v1: ${pretty(resolved)}`);
console.log('OK   old hash resolves to the passport (version 1)');

// --- 6. Old claim still verifies --------------------------------------------
if (claim) {
    step('Old ZK claim verifies against its version');
    const cv = await get(`/api/v1/passport/verifyClaimOnChain(passportId=${q(pid)},sourceField=${q(claim.sourceField)},predicate=${q(claim.predicate)},threshold=${claim.threshold})`, { anon: true });
    if (cv.verified !== true) fail(`old claim did not verify after re-anchor: ${pretty(cv)}`);
    console.log('OK   claim proven under v1 still verifies after the re-anchor');
}

console.log(`\nREANCHOR E2E PASSED. ${pid}: v1 ${short(v1Hash)} (superseded, verifiable) -> v2 ${short(v2Hash)} (current).`);
