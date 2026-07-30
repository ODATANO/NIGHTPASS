// Battery lifecycle e2e against a RUNNING NIGHTPASS server (chain-free):
//
//   create passport (LMT) -> changeBatteryStatus(repurposed) -> recycler tier
//   sees it, history is versioned (source 'lifecycle'), the DPP document's
//   DPPStatus follows the lifecycle (waste -> Archived), and
//   dppsByProductIdAndDate serves the status that was current at the date.
//   Plus the authorization probes: producer-only, owner-scope guard, illegal
//   transitions.
//
//   Server (scratch DB recommended):
//     cds_requires_db_credentials_database=<scratch> DPP_API_ENABLED=true \
//     PRODUCER_WALLETS=T PRODUCER_T_SHIELDED_ADDRESS=addr-owner-T npm start
//   Then: node test/integration/lifecycle-e2e.mjs
//
// No wallet or chain needed: status changes without a session land as
// mode 'offline' (drift), which is exactly what this test asserts.

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const PRODUCER = 'Basic ' + Buffer.from('producer:producer').toString('base64');
const RECYCLER = 'Basic ' + Buffer.from('recycler:recycler').toString('base64');

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => encodeURIComponent(`'${String(s).replace(/'/g, "''")}'`);

async function http(method, path, { body, auth } = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: auth } : {}) },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}
const changeStatus = (pid, newStatus, extra = {}, auth = PRODUCER) =>
    http('POST', '/api/v1/producer/changeBatteryStatus', { auth, body: { passportId: pid, newStatus, ...extra } });
const guideStatus = (doc) => (doc?.Battery_Passport ?? doc)?.IdentifiersAndProductData?.DPPStatus?.dppStatusValue;
const guideBatteryStatus = (doc) => (doc?.Battery_Passport ?? doc)?.IdentifiersAndProductData?.BatteryStatus?.batteryStatusValues;

// --- 1. Create passport (LMT) + anchored shortcut ---------------------------
step('Create passport');
const pid = `BAT-LC-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const created = await http('POST', '/api/v1/producer/createPassport', {
    auth: PRODUCER,
    body: {
        passportJson: JSON.stringify({
            passportId: pid, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'LMT',
            model: 'CityCharge LMT-15', manufactureDate: '2026-05-01', weightKg: 12.5, performanceClass: 'B',
            batteries: [{ serialNumber: `SN-${pid}`, cellChemistry: 'LFP', capacityKwh: 1.2, carbonFootprintKgCO2: 88, supplierName: 'CellCraft AB' }],
            recycledMaterials: [{ material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt Recyclers SA' }]
        }),
        submit: false
    }
});
if (created.status !== 200) fail(`createPassport -> ${created.status}: ${pretty(created.body)}`);
const rowRes = await http('GET', `/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=ID`, { auth: PRODUCER });
const rowId = rowRes.body?.value?.[0]?.ID;
if (!rowId) fail('row not found');
// Test-only shortcut: the DPP API serves anchored passports only.
const patched = await http('PATCH', `/api/v1/producer/Passports(${rowId})`, { auth: PRODUCER, body: { status: 'anchored' } });
if (patched.status >= 300) fail(`PATCH -> ${patched.status}`);
console.log(`OK   ${pid} created + marked anchored (test shortcut)`);

const doc0 = await http('GET', `/dpp-api/v1/dpps/${pid}`);
if (doc0.status === 404) fail('DPP API not mounted; start the server with DPP_API_ENABLED=true');
if (guideStatus(doc0.body) !== 'Active') fail(`initial DPPStatus expected Active, got ${guideStatus(doc0.body)}`);
if (guideBatteryStatus(doc0.body) !== 'original') fail(`initial BatteryStatus expected original, got ${guideBatteryStatus(doc0.body)}`);
console.log('OK   DPP doc: BatteryStatus original / DPPStatus Active');

await sleep(1100);
const t0 = new Date().toISOString();
await sleep(1100);

// --- 2. Authorization probes -------------------------------------------------
step('Authorization probes');
const asRecycler = await changeStatus(pid, 'repurposed', {}, RECYCLER);
if (asRecycler.status !== 403) fail(`recycler should get 403, got ${asRecycler.status}`);
console.log('OK   recycler login rejected (403; producer role required)');

// Owner-scope guard: give the row a foreign owner and use registry wallet 'T'.
const owned = await http('PATCH', `/api/v1/producer/Passports(${rowId})`, { auth: PRODUCER, body: { owner: 'addr-owner-someone-else' } });
if (owned.status >= 300) fail(`owner PATCH -> ${owned.status}`);
const wrongWallet = await changeStatus(pid, 'repurposed', { walletId: 'T' });
if (wrongWallet.status !== 403) fail(`foreign owner should give 403, got ${wrongWallet.status}: ${pretty(wrongWallet.body)}`);
console.log('OK   owner-scope mismatch rejected (403)');
await http('PATCH', `/api/v1/producer/Passports(${rowId})`, { auth: PRODUCER, body: { owner: null } });

const unknown = await changeStatus(pid, 'recycled');
if (unknown.status !== 400) fail(`unknown status should give 400, got ${unknown.status}`);
console.log('OK   unknown status rejected (400)');

// --- 3. original -> repurposed ----------------------------------------------
step('original -> repurposed (offline, no session)');
const re = await changeStatus(pid, 'repurposed');
if (re.status !== 200) fail(`changeBatteryStatus -> ${re.status}: ${pretty(re.body)}`);
if (re.body.previousStatus !== 'original' || re.body.newStatus !== 'repurposed' || re.body.mode !== 'offline') {
    fail(`unexpected result: ${pretty(re.body)}`);
}
console.log('OK   transition recorded (mode offline = drift until next re-anchor)');

const recyclerView = await http('GET',
    `/api/v1/passport/PassportAttributes?$filter=passport_ID eq ${rowId} and attribute eq 'BatteryStatus'&$select=valueJson`,
    { auth: RECYCLER });
const seen = JSON.parse(recyclerView.body?.value?.[0]?.valueJson ?? '{}')?.batteryStatusValues;
if (seen !== 'repurposed') fail(`recycler should see repurposed, got ${seen}`);
console.log('OK   recycler tier sees the new status');

const hist = await http('GET',
    `/api/v1/producer/PassportAttributeHistory?$filter=passport_ID eq ${rowId} and attribute eq 'BatteryStatus'&$select=version,valueJson,source&$orderby=version`,
    { auth: PRODUCER });
const versions = hist.body?.value ?? [];
if (versions.length !== 2) fail(`expected baseline + 1 lifecycle version, got ${pretty(versions)}`);
if (versions[0].source !== 'baseline' || versions[1].source !== 'lifecycle') fail(`history sources wrong: ${pretty(versions)}`);
console.log('OK   history: baseline (original) + v1 (lifecycle)');

const drift = await http('GET', `/api/v1/producer/passportDrift(passportId=${q(pid)})`, { auth: PRODUCER });
if (drift.body?.drifted !== true) fail('status change must drift the anchored passport');
console.log('OK   drift detected (status change awaits re-anchor)');

await sleep(1100);
const t1 = new Date().toISOString();
await sleep(1100);

// --- 4. repurposed -> waste + DPPStatus --------------------------------------
step('repurposed -> waste (DPPStatus Archived)');
const backToOriginal = await changeStatus(pid, 'original');
if (backToOriginal.status !== 400) fail(`repurposed -> original should give 400, got ${backToOriginal.status}`);
const waste = await changeStatus(pid, 'waste');
if (waste.status !== 200 || waste.body.newStatus !== 'waste') fail(`waste transition -> ${waste.status}: ${pretty(waste.body)}`);
const terminal = await changeStatus(pid, 'repurposed');
if (terminal.status !== 400) fail(`waste is terminal, got ${terminal.status}`);
console.log('OK   waste reached; terminal + backward transitions rejected (400)');

const docNow = await http('GET', `/dpp-api/v1/dpps/${pid}`);
if (guideStatus(docNow.body) !== 'Archived') fail(`DPPStatus expected Archived, got ${guideStatus(docNow.body)}`);
if (guideBatteryStatus(docNow.body) !== 'waste') fail(`BatteryStatus expected waste, got ${guideBatteryStatus(docNow.body)}`);
console.log('OK   DPP doc now: BatteryStatus waste / DPPStatus Archived');

// --- 5. As-of history --------------------------------------------------------
step('dppsByProductIdAndDate serves the status current at the date');
const asOfT0 = await http('GET', `/dpp-api/v1/dppsByProductIdAndDate/${pid}?date=${encodeURIComponent(t0)}`);
if (guideBatteryStatus(asOfT0.body) !== 'original' || guideStatus(asOfT0.body) !== 'Active') {
    fail(`as-of t0 expected original/Active, got ${guideBatteryStatus(asOfT0.body)}/${guideStatus(asOfT0.body)}`);
}
const asOfT1 = await http('GET', `/dpp-api/v1/dppsByProductIdAndDate/${pid}?date=${encodeURIComponent(t1)}`);
if (guideBatteryStatus(asOfT1.body) !== 'repurposed' || guideStatus(asOfT1.body) !== 'Active') {
    fail(`as-of t1 expected repurposed/Active, got ${guideBatteryStatus(asOfT1.body)}/${guideStatus(asOfT1.body)}`);
}
const asOfNow = await http('GET', `/dpp-api/v1/dppsByProductIdAndDate/${pid}?date=${encodeURIComponent(new Date().toISOString())}`);
if (guideBatteryStatus(asOfNow.body) !== 'waste' || guideStatus(asOfNow.body) !== 'Archived') {
    fail(`as-of now expected waste/Archived, got ${guideBatteryStatus(asOfNow.body)}/${guideStatus(asOfNow.body)}`);
}
console.log('OK   t0 original/Active, t1 repurposed/Active, now waste/Archived');

console.log(`\nLIFECYCLE E2E PASSED. ${pid}: original -> repurposed -> waste, DPPStatus mirrors, history versioned, gates hold.`);
