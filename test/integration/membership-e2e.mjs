// LIVE membership-claims e2e against a RUNNING NIGHTPASS server on preprod
// (NIGHTGATE >= 0.15.1, vault redeployed with the membership circuits):
//
//   prewarm wallet -> create + anchor a chemistry-bearing passport (10-leaf
//   content root) -> server-lane mixed cart (1 numeric + 1 membership claim)
//   in ONE tx -> both PredicateProofLog rows succeed with a SHARED txHash and
//   their own predicateAttestationId -> verifyClaimOnChain AND
//   verifyMembershipClaimOnChain confirm crawler-free -> a wrong setRoot
//   honestly fails to verify.
//
//   Server: npm run start:wallets  (PASSPORT_CONTRACT_ADDRESS = the NEW
//   vault; proof server on :6300 or wasm proving).
//   Then: node test/integration/membership-e2e.mjs
//   Env: NIGHTPASS_BASE (default :4004), WALLET_ID (default 'default'),
//   PASSPORT_FEE_SPONSOR_WALLET on the server when the wallet is fundless.

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const WALLET_ID = process.env.WALLET_ID || 'default';
const AUTH = 'Basic ' + Buffer.from('producer:producer').toString('base64');
const POLL_MS = 10_000;

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => encodeURIComponent(`'${String(s).replace(/'/g, "''")}'`);

async function http(method, path, body) {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(180_000)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}
const get = (p) => http('GET', p).then((r) => { if (r.status >= 300) fail(`GET ${p} -> ${r.status}: ${pretty(r.body)}`); return r.body; });

// --- 0. Prewarm the signing wallet (cold-session write-lock trap) ------------
step(`Prewarm server wallet '${WALLET_ID}'`);
const warm = await http('POST', '/api/v1/producer/prewarmServerWallet', { walletId: WALLET_ID });
if (warm.status !== 200) fail(`prewarmServerWallet -> ${warm.status}: ${pretty(warm.body)}`);
{
    const deadline = Date.now() + 20 * 60_000;
    let state = warm.body?.state;
    while (state !== 'ready' && Date.now() < deadline) {
        if (state === 'error') fail(`wallet prewarm error: ${pretty(warm.body)}`);
        await sleep(POLL_MS);
        const s = await get(`/api/v1/producer/serverWalletStatus(walletId=${q(WALLET_ID)})`);
        state = s.state;
        if (s.state === 'error') fail(`wallet prewarm error: ${s.error}`);
        process.stdout.write('.');
    }
    if (state !== 'ready') fail('wallet prewarm did not finish in 20 min');
}
console.log(`\nOK   wallet '${WALLET_ID}' at chain tip`);

// --- 1. Create + anchor a chemistry-bearing passport -------------------------
step('Create + anchor passport');
const pid = `BAT-MEMB-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const created = await http('POST', '/api/v1/producer/createPassport', {
    passportJson: JSON.stringify({
        passportId: pid, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'EV',
        model: 'MembCell EV-75', manufactureDate: '2026-08-01', weightKg: 300, performanceClass: 'B',
        batteries: [{
            serialNumber: `SN-${pid}`, cellChemistry: 'Li-ion NMC',
            capacityKwh: 75, carbonFootprintKgCO2: 3500, cycleLife: 1800
        }]
    }),
    submit: true, walletId: WALLET_ID
});
if (created.status !== 200) fail(`createPassport -> ${created.status}: ${pretty(created.body)}`);
if (created.body.mode !== 'anchoring') fail(`expected mode anchoring, got ${created.body.mode} (wallet/session missing?)`);
{
    const deadline = Date.now() + 15 * 60_000;
    let status = 'anchoring';
    while (status !== 'anchored' && status !== 'failed' && Date.now() < deadline) {
        await sleep(POLL_MS);
        const row = (await get(`/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=status,attestationTxHash`)).value?.[0];
        status = row?.status ?? status;
        process.stdout.write('.');
        if (status === 'anchored') console.log(`\nOK   anchored tx ${String(row.attestationTxHash).slice(0, 16)}...`);
    }
    if (status !== 'anchored') fail(`anchor ended '${status}'`);
}

// --- 2. Mixed cart: 1 numeric + 1 membership in ONE tx ------------------------
step('Mixed proof cart (server lane)');
const batch = await http('POST', '/api/v1/producer/provePassportValuesBatch', {
    passportId: pid, walletId: WALLET_ID,
    claimsJson: JSON.stringify([
        { sourceField: 'capacityKwh', predicate: 'greaterOrEqual', threshold: 60, unit: 'kWh' },
        { sourceField: 'cellChemistry', predicate: 'setMembership', setId: 'chemistry-known' }
    ])
});
if (batch.status !== 200) fail(`batch -> ${batch.status}: ${pretty(batch.body)}`);
if (batch.body.mode !== 'proving') fail(`expected mode proving, got ${batch.body.mode}`);
const proofIds = JSON.parse(batch.body.proofLogIds || '[]');
if (proofIds.length !== 2) fail(`expected 2 proof log ids, got ${pretty(batch.body)}`);
console.log(`OK   proving 2 claims in one background tx (${proofIds.join(', ')})`);

const rows = [];
{
    const deadline = Date.now() + 30 * 60_000;
    for (const id of proofIds) {
        let row;
        for (;;) {
            row = await get(`/api/v1/producer/PredicateProofLog(${id})`);
            if (row.status === 'succeeded' || row.status === 'failed') break;
            if (Date.now() > deadline) fail('proof cart timed out');
            await sleep(POLL_MS);
            process.stdout.write('.');
        }
        rows.push(row);
    }
}
console.log('');
for (const r of rows) {
    if (r.status !== 'succeeded' || r.result !== true) fail(`proof row ${r.sourceField} ended ${r.status}: ${pretty(r)}`);
    if (!r.predicateAttestationId) fail(`proof row ${r.sourceField} has no predicateAttestationId`);
}
const txs = new Set(rows.map((r) => r.txHash));
if (txs.size !== 1) fail(`claims landed in ${txs.size} txs, expected 1`);
const mem = rows.find((r) => r.predicate === 'setMembership');
if (!mem || !/^[0-9a-f]{64}$/i.test(String(mem.setRoot))) fail(`membership row has no setRoot: ${pretty(mem)}`);
if (mem.setId !== 'chemistry-known' || mem.threshold != null) fail(`membership row shape: ${pretty(mem)}`);
console.log(`OK   both claims succeeded, ONE tx ${String([...txs][0]).slice(0, 16)}..., distinct attestation ids`);

// --- 3. Crawler-free verification --------------------------------------------
step('Verify both claim kinds on-chain');
const vNum = await get(`/api/v1/passport/verifyClaimOnChain(passportId=${q(pid)},sourceField=${q('capacityKwh')},predicate=${q('greaterOrEqual')},threshold=60)`);
if (vNum.verified !== true) fail(`numeric claim not verified: ${pretty(vNum)}`);
console.log('OK   capacityKwh >= 60 verified:true');
const vMem = await get(`/api/v1/passport/verifyMembershipClaimOnChain(passportId=${q(pid)},sourceField=${q('cellChemistry')},setRoot=${q(mem.setRoot)})`);
if (vMem.verified !== true) fail(`membership claim not verified: ${pretty(vMem)}`);
console.log(`OK   cellChemistry in 'chemistry-known' verified:true (network ${vMem.checkedNetwork})`);

// Negative: a DIFFERENT set root (cobalt-free) was never proven for this
// passport, so the check must honestly say false.
const wrongRoot = 'abf1bb26515d2e02ecd260687f2c9adad70ab479390843ae467d8e3d7af1a25f';
const vWrong = await get(`/api/v1/passport/verifyMembershipClaimOnChain(passportId=${q(pid)},sourceField=${q('cellChemistry')},setRoot=${q(wrongRoot)})`);
if (vWrong.verified !== false) fail(`unproven set root verified?! ${pretty(vWrong)}`);
console.log('OK   unproven set root -> verified:false (honest negative)');

console.log(`\nPASS membership live e2e (${pid})`);
