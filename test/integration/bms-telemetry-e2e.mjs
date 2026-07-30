// BMS telemetry ingest e2e against a RUNNING NIGHTPASS server:
//
//   create passport (LMT, full dynamic set) -> HMAC-signed telemetry batch
//   POST /api/v1/passport/telemetry -> recycler tier sees the new value,
//   history is versioned, and /dpp-api/v1/dppsByProductIdAndDate serves the
//   value that was current at the requested date.
//
//   TELEMETRY_WEBHOOK_SECRET=<s> DPP_API_ENABLED=true npm start   (terminal 1)
//   node --env-file=.env test/integration/bms-telemetry-e2e.mjs   (terminal 2)
//
// Env knobs:
//   NIGHTPASS_BASE             default http://localhost:4004
//   TELEMETRY_WEBHOOK_SECRET   required (same value the SERVER runs with)
//
// No wallet or chain needed: the passport is created offline and the status is
// set to 'anchored' through the producer projection (test-only shortcut; the
// DPP API serves anchored passports only). Use a scratch DB when you do not
// want the row to stick around.

import crypto from 'node:crypto';

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const SECRET = process.env.TELEMETRY_WEBHOOK_SECRET;
const PRODUCER = 'Basic ' + Buffer.from('producer:producer').toString('base64');
const RECYCLER = 'Basic ' + Buffer.from('recycler:recycler').toString('base64');

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SECRET) fail('TELEMETRY_WEBHOOK_SECRET env var is required (run with node --env-file=.env)');

async function http(method, path, { body, auth, headers } = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(auth ? { Authorization: auth } : {}),
            ...(headers ?? {})
        },
        body: body == null ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
        signal: AbortSignal.timeout(60_000)
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

function signed(payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return { body: raw, headers: { 'x-bms-signature': signature } };
}

async function postTelemetry(payload) {
    const { body, headers } = signed(payload);
    return http('POST', '/api/v1/passport/telemetry', { body, headers });
}

const attrValue = (rows, name) => {
    const row = (rows ?? []).find((r) => r.attribute === name);
    return row ? JSON.parse(row.valueJson) : undefined;
};
const guideSections = (doc) => doc?.Battery_Passport ?? doc ?? {};
const guideCapacityFade = (doc) => guideSections(doc)?.PerformanceAndDurability?.CapacityFade?.percentageValue;
const guideLastUpdate = (doc) => guideSections(doc)?.IdentifiersAndProductData?.['Date-timeOfLatestUpdateOfDPP'];

// --- 1. Create an LMT passport (full dynamic set) and mark it anchored ------
step('Create passport');
const pid = `BAT-BMS-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
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
console.log(`OK   created ${pid} (offline draft)`);

const rowRes = await http('GET', `/api/v1/producer/Passports?$filter=passportId eq '${pid}'&$select=ID,status,createdAt`, { auth: PRODUCER });
const rowId = rowRes.body?.value?.[0]?.ID;
if (!rowId) fail('passport row not found after create');

// Test-only shortcut: the DPP API read-through serves anchored passports only.
const patched = await http('PATCH', `/api/v1/producer/Passports(${rowId})`, { auth: PRODUCER, body: { status: 'anchored' } });
if (patched.status >= 300) fail(`PATCH status -> ${patched.status}: ${pretty(patched.body)}`);
console.log('OK   status set to anchored (test shortcut, no chain involved)');

// --- 2. Baseline reads + t0 --------------------------------------------------
step('Baseline reads');
const attrsUrl = `/api/v1/passport/PassportAttributes?$filter=passport_ID eq ${rowId}&$select=attribute,valueJson,accessClass&$top=200`;
const before = await http('GET', attrsUrl, { auth: RECYCLER });
const fadeBefore = attrValue(before.body?.value, 'CapacityFade')?.percentageValue;
if (fadeBefore !== 0.8) fail(`recycler baseline CapacityFade expected 0.8, got ${fadeBefore}`);
console.log(`OK   recycler sees seeded CapacityFade ${fadeBefore}`);

const anon = await http('GET', attrsUrl);
if ((anon.body?.value ?? []).some((r) => r.attribute === 'CapacityFade')) {
    fail('anonymous read must not see legitimateInterest rows');
}
console.log('OK   anonymous read hides the dynamic (legitimateInterest) rows');

const docT0 = await http('GET', `/dpp-api/v1/dpps/${pid}`);
if (docT0.status === 404) fail('DPP API not mounted; start the server with DPP_API_ENABLED=true');
if (docT0.status !== 200) fail(`GET /dpp-api/v1/dpps/${pid} -> ${docT0.status}`);
if (guideCapacityFade(docT0.body) !== 0.8) fail(`DPP doc baseline CapacityFade expected 0.8, got ${guideCapacityFade(docT0.body)}`);

await sleep(1100);
const t0 = new Date().toISOString();
await sleep(1100);

// --- 3. Guard probes ---------------------------------------------------------
step('Guard probes');
const badSig = await http('POST', '/api/v1/passport/telemetry', {
    body: JSON.stringify({ passportId: pid, updates: [{ attribute: 'CapacityFade', value: 2 }] }),
    headers: { 'Content-Type': 'application/json', 'x-bms-signature': 'sha256=' + '0'.repeat(64) }
});
if (badSig.status !== 401) fail(`bad signature should give 401, got ${badSig.status}`);
console.log('OK   invalid signature rejected (401)');

const notAllowed = await postTelemetry({ passportId: pid, updates: [{ attribute: 'RatedCapacity', value: 250 }] });
if (notAllowed.status !== 400) fail(`non-dynamic attribute should give 400, got ${notAllowed.status}`);
console.log('OK   non-allowlisted attribute rejected (400)');

const badValue = await postTelemetry({ passportId: pid, updates: [{ attribute: 'CapacityFade', value: 250 }] });
if (badValue.status !== 400) fail(`out-of-range value should give 400, got ${badValue.status}`);
console.log('OK   out-of-range value rejected (400)');

const ghost = await postTelemetry({ passportId: 'BAT-NO-SUCH-PASS', updates: [{ attribute: 'CapacityFade', value: 2 }] });
if (ghost.status !== 404) fail(`unknown passport should give 404, got ${ghost.status}`);
console.log('OK   unknown passport rejected (404)');

// --- 4. First telemetry batch ------------------------------------------------
step('Telemetry batch 1');
const batch1 = await postTelemetry({
    passportId: pid,
    updates: [
        { attribute: 'CapacityFade', value: 5.5 },
        { attribute: 'RemainingCapacity', value: 190 },
        { attribute: 'NumberOfDeepDischargeEvents', value: 4 }
    ]
});
if (batch1.status !== 200 || batch1.body?.updated !== 3) fail(`batch 1 -> ${batch1.status}: ${pretty(batch1.body)}`);
console.log(`OK   ${batch1.body.updated} attribute(s) updated: ${pretty(batch1.body.results)}`);

const after1 = await http('GET', attrsUrl, { auth: RECYCLER });
const fadeAfter1 = attrValue(after1.body?.value, 'CapacityFade')?.percentageValue;
if (fadeAfter1 !== 5.5) fail(`recycler CapacityFade after batch 1 expected 5.5, got ${fadeAfter1}`);
const remCap = attrValue(after1.body?.value, 'RemainingCapacity');
if (remCap?.amperehourMiliamperehourValue !== 190 || remCap?.ampereHourMiliamperehour !== 'Ah') {
    fail(`RemainingCapacity guide shape wrong: ${JSON.stringify(remCap)}`);
}
console.log('OK   recycler tier sees the updated values in correct guide shapes');

// --- 5. Second batch via the mock-BMS simulator action -----------------------
step('Telemetry batch 2 (mock-sap triggerBmsTelemetry)');
await sleep(1100);
const t1 = new Date().toISOString();
await sleep(1100);
const sim = await http('POST', '/api/v1/mock-sap/triggerBmsTelemetry', { auth: PRODUCER, body: { passportId: pid, ticks: 1 } });
if (sim.status !== 200 || !(sim.body?.updated > 0)) fail(`triggerBmsTelemetry -> ${sim.status}: ${pretty(sim.body)}`);
console.log(`OK   simulator applied tick ${sim.body.fromTick} (${sim.body.updated} updates)`);

// --- 6. History + as-of consistency ------------------------------------------
step('History and dppsByProductIdAndDate');
const hist = await http('GET',
    `/api/v1/producer/PassportAttributeHistory?$filter=passport_ID eq ${rowId} and attribute eq 'CapacityFade'&$select=version,valueJson,source&$orderby=version`,
    { auth: PRODUCER });
const versions = hist.body?.value ?? [];
if (versions.length !== 3) fail(`expected 3 CapacityFade history rows (baseline+2), got ${versions.length}: ${pretty(versions)}`);
if (versions[0].version !== 0 || versions[0].source !== 'baseline') fail(`version 0 must be the baseline: ${pretty(versions[0])}`);
if (JSON.parse(versions[1].valueJson).percentageValue !== 5.5) fail('version 1 must hold the batch-1 value');
console.log('OK   history: baseline + 2 versions, sources ' + versions.map((v) => v.source).join('/'));

const asOfT0 = await http('GET', `/dpp-api/v1/dppsByProductIdAndDate/${pid}?date=${encodeURIComponent(t0)}`);
if (asOfT0.status !== 200) fail(`byProductIdAndDate(t0) -> ${asOfT0.status}`);
if (guideCapacityFade(asOfT0.body) !== 0.8) fail(`as-of t0 must serve the ORIGINAL value 0.8, got ${guideCapacityFade(asOfT0.body)}`);
console.log('OK   date=t0 serves the creation-time value (0.8)');

const asOfT1 = await http('GET', `/dpp-api/v1/dppsByProductIdAndDate/${pid}?date=${encodeURIComponent(t1)}`);
if (guideCapacityFade(asOfT1.body) !== 5.5) fail(`as-of t1 must serve the batch-1 value 5.5, got ${guideCapacityFade(asOfT1.body)}`);
console.log('OK   date=t1 serves the batch-1 value (5.5)');

const asOfNow = await http('GET', `/dpp-api/v1/dppsByProductIdAndDate/${pid}?date=${encodeURIComponent(new Date().toISOString())}`);
const fadeNow = guideCapacityFade(asOfNow.body);
if (!(fadeNow > 0.8) || fadeNow === 5.5) fail(`as-of now must serve the simulator value, got ${fadeNow}`);
console.log(`OK   date=now serves the simulator value (${fadeNow})`);

const lastUpdT0 = guideLastUpdate(asOfT0.body);
const lastUpdNow = guideLastUpdate(asOfNow.body);
if (!(String(lastUpdNow) > String(lastUpdT0))) {
    fail(`Date-timeOfLatestUpdateOfDPP must advance: t0=${lastUpdT0} now=${lastUpdNow}`);
}
console.log(`OK   Date-timeOfLatestUpdateOfDPP advanced (${lastUpdT0} -> ${lastUpdNow})`);

console.log(`\nBMS TELEMETRY E2E PASSED. Passport ${pid}: recycler view updated, history versioned, as-of dates consistent.`);
