// Operator-handover e2e against a RUNNING NIGHTPASS server (chain-free):
//
//   draft passport owned by wallet T -> transferPassportOperator to wallet U
//   (mode 'local', owner flips) -> old operator T is blocked by the owner
//   guard (403), new operator U can update. Plus the guard probes: unknown
//   target 400, repeat transfer 400, recycler 403, anchored-without-registrar
//   400 (the on-chain path needs the registrar session; that leg is proven in
//   the live run).
//
//   Server (scratch DB):
//     cds_requires_db_credentials_database=<scratch> \
//     PRODUCER_WALLETS=T,U \
//     PRODUCER_T_SHIELDED_ADDRESS=addr-owner-T PRODUCER_T_WALLET_MNEMONIC=x PRODUCER_T_VIEWING_KEY=x \
//     PRODUCER_U_SHIELDED_ADDRESS=addr-owner-U PRODUCER_U_WALLET_MNEMONIC=x PRODUCER_U_VIEWING_KEY=x \
//     npm start
//   Then: node test/integration/handover-e2e.mjs

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const PRODUCER = 'Basic ' + Buffer.from('producer:producer').toString('base64');
const RECYCLER = 'Basic ' + Buffer.from('recycler:recycler').toString('base64');

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }
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
const transfer = (pid, newWalletId, auth = PRODUCER) =>
    http('POST', '/api/v1/producer/transferPassportOperator', { auth, body: { passportId: pid, newWalletId } });
const changeStatus = (pid, newStatus, walletId) =>
    http('POST', '/api/v1/producer/changeBatteryStatus', { auth: PRODUCER, body: { passportId: pid, newStatus, walletId } });

// --- 1. Create draft owned by T ----------------------------------------------
step('Create draft passport owned by wallet T');
const pid = `BAT-HO-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const created = await http('POST', '/api/v1/producer/createPassport', {
    auth: PRODUCER,
    body: {
        passportJson: JSON.stringify({
            passportId: pid, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'LMT',
            model: 'CityCharge LMT-15', manufactureDate: '2026-05-01', weightKg: 12.5, performanceClass: 'B',
            batteries: [{ serialNumber: `SN-${pid}`, cellChemistry: 'LFP', capacityKwh: 1.2, carbonFootprintKgCO2: 88, supplierName: 'CellCraft AB' }],
            recycledMaterials: [{ material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt Recyclers SA' }]
        }),
        submit: false, owner: 'addr-owner-T'
    }
});
if (created.status !== 200) fail(`createPassport -> ${created.status}: ${pretty(created.body)}`);
console.log(`OK   ${pid} created (draft, owner T)`);

// --- 2. Guard probes -----------------------------------------------------------
step('Guard probes');
const asRecycler = await transfer(pid, 'U', RECYCLER);
if (asRecycler.status !== 403) fail(`recycler should get 403, got ${asRecycler.status}`);
console.log('OK   recycler rejected (403)');

const unknownTarget = await transfer(pid, 'Z');
if (unknownTarget.status !== 400) fail(`unknown target should give 400, got ${unknownTarget.status}`);
console.log('OK   unknown target wallet rejected (400)');

const foreign = await changeStatus(pid, 'repurposed', 'U');
if (foreign.status !== 403) fail(`wallet U must not update T's passport yet, got ${foreign.status}`);
console.log('OK   pre-handover: wallet U blocked by the owner guard (403)');

// --- 3. Handover T -> U (local, draft) ----------------------------------------
step('transferPassportOperator T -> U');
const t = await transfer(pid, 'U');
if (t.status !== 200) fail(`transfer -> ${t.status}: ${pretty(t.body)}`);
if (t.body.mode !== 'local' || t.body.previousOwner !== 'addr-owner-T' || t.body.newOwner !== 'addr-owner-U') {
    fail(`unexpected transfer result: ${pretty(t.body)}`);
}
const row = (await http('GET', `/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=owner`, { auth: PRODUCER })).body?.value?.[0];
if (row?.owner !== 'addr-owner-U') fail(`owner not flipped: ${pretty(row)}`);
console.log('OK   owner flipped to U (mode local, draft never touched the chain)');

const again = await transfer(pid, 'U');
if (again.status !== 400) fail(`repeat transfer should give 400, got ${again.status}`);
console.log('OK   repeat transfer to the same wallet rejected (400)');

// --- 4. Acceptance: new operator updates, old one cannot ----------------------
step('Post-handover authorization');
const oldOem = await changeStatus(pid, 'repurposed', 'T');
if (oldOem.status !== 403) fail(`OLD operator T must be blocked, got ${oldOem.status}: ${pretty(oldOem.body)}`);
console.log('OK   old operator T blocked (403, owner guard)');

const newOp = await changeStatus(pid, 'repurposed', 'U');
if (newOp.status !== 200 || newOp.body.newStatus !== 'repurposed') {
    fail(`NEW operator U must be able to update, got ${newOp.status}: ${pretty(newOp.body)}`);
}
console.log(`OK   new operator U updates the passport (status -> repurposed, mode ${newOp.body.mode})`);

// --- 5. Anchored path requires the chain --------------------------------------
step('Anchored passports need the registrar (on-chain leg)');
const rowId = (await http('GET', `/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=ID`, { auth: PRODUCER })).body?.value?.[0]?.ID;
await http('PATCH', `/api/v1/producer/Passports(${rowId})`, { auth: PRODUCER, body: { status: 'anchored' } });
const anchoredTransfer = await transfer(pid, 'T');
if (anchoredTransfer.status !== 400) fail(`anchored transfer without contract/registrar should give 400, got ${anchoredTransfer.status}`);
console.log('OK   anchored handover without registrar session/contract rejected (400)');

console.log(`\nHANDOVER E2E PASSED. ${pid}: T -> U, old operator locked out, new operator updates.`);
