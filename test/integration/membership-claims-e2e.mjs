// Membership-claims e2e against a RUNNING NIGHTPASS server (chain-free):
//
//   mixed proof cart (numeric + setMembership) without a session -> offline
//   PredicateProofLog rows with the canonical setRoot/setId and a null
//   threshold; the guard 400s (unknown set, wrong field, non-member value,
//   membership on the single action); the ingest endpoint round-trips a
//   membership claim (and drops a malformed one); anchorExplorer publishes
//   the allow-list; verifyMembershipClaimOnChain degrades to verified:false
//   without a chain; recordWalletMembership validates and logs.
//
//   Server (scratch DB; the secretless registry override keeps the .env
//   wallet/vault out so the batch really lands offline):
//     cds_requires_db_credentials_database=<scratch> PASSPORT_INGEST_SECRET=test-ingest \
//     PRODUCER_WALLETS=T PRODUCER_T_SHIELDED_ADDRESS=addr-owner-T \
//     PASSPORT_CONTRACT_ADDRESS= npm start
//   Then: node test/integration/membership-claims-e2e.mjs
//
// No wallet or chain needed: batch proofs without a session land as mode
// 'offline', which is exactly what this test asserts.

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const INGEST_SECRET = process.env.PASSPORT_INGEST_SECRET || 'test-ingest';
const PRODUCER = 'Basic ' + Buffer.from('producer:producer').toString('base64');

// Golden root of the 'chemistry-known' set (pinned in membership-set.test.ts
// against NIGHTGATE's canonical implementation).
const KNOWN_ROOT = '0f9578be18a29a5ba5e941be2f8e7f8e80b3fc25f0389b6f4f35a83528aa94be';

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }
const q = (s) => encodeURIComponent(`'${String(s).replace(/'/g, "''")}'`);

async function http(method, path, { body, auth, bearer } = {}) {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(auth ? { Authorization: auth } : {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
        },
        body: body == null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

// --- 1. Create a chemistry-bearing passport ---------------------------------
step('Create passport');
const pid = `BAT-MEM-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const created = await http('POST', '/api/v1/producer/createPassport', {
    auth: PRODUCER,
    body: {
        passportJson: JSON.stringify({
            passportId: pid, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'EV',
            model: 'MemCell EV-75', manufactureDate: '2026-08-01', weightKg: 300, performanceClass: 'B',
            batteries: [{ serialNumber: `SN-${pid}`, cellChemistry: 'Li-ion NMC', capacityKwh: 75, carbonFootprintKgCO2: 3500 }]
        }),
        submit: false
    }
});
if (created.status !== 200) fail(`createPassport -> ${created.status}: ${pretty(created.body)}`);
const rowRes = await http('GET', `/api/v1/producer/Passports?$filter=passportId eq ${q(pid)}&$select=ID,payloadHash`, { auth: PRODUCER });
const row = rowRes.body?.value?.[0];
if (!row?.ID) fail('row not found');
console.log(`OK   ${pid} created (draft)`);

// --- 2. Mixed cart without a session -> offline rows -------------------------
step('Mixed cart, offline lane');
// Bounded retry on the known post-boot write-lock transient (first request
// after a cold boot can lose the SQLite write lock to plugin housekeeping).
let batch;
for (let attempt = 1; ; attempt++) {
    batch = await http('POST', '/api/v1/producer/provePassportValuesBatch', {
        auth: PRODUCER,
        body: {
            passportId: pid,
            claimsJson: JSON.stringify([
                { sourceField: 'capacityKwh', predicate: 'greaterOrEqual', threshold: 60, unit: 'kWh' },
                { sourceField: 'cellChemistry', predicate: 'setMembership', setId: 'chemistry-known' },
                { sourceField: 'cellChemistry', predicate: 'setMembership', setId: 'chemistry-known' } // duplicate
            ])
        }
    });
    if (batch.status === 500 && /locked/i.test(String(batch.body?.error?.message)) && attempt < 4) {
        console.log(`retry ${attempt}: transient post-boot write lock`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
    }
    break;
}
if (batch.status !== 200) fail(`batch -> ${batch.status}: ${pretty(batch.body)}`);
if (batch.body.mode !== 'offline') fail(`expected mode offline, got ${batch.body.mode}`);
if (batch.body.dropped !== 1) fail(`expected 1 dropped duplicate, got ${batch.body.dropped}`);
const logs = await http('GET',
    `/api/v1/producer/PredicateProofLog?$filter=passport_ID eq ${row.ID}&$select=sourceField,predicate,threshold,setRoot,setId,status`,
    { auth: PRODUCER });
const rows = logs.body?.value ?? [];
const mem = rows.find((r) => r.predicate === 'setMembership');
const num = rows.find((r) => r.predicate === 'greaterOrEqual');
if (rows.length !== 2 || !mem || !num) fail(`expected 1 numeric + 1 membership offline row, got ${pretty(rows)}`);
if (mem.status !== 'offline' || mem.threshold != null) fail(`membership row shape wrong: ${pretty(mem)}`);
if (String(mem.setRoot).toLowerCase() !== KNOWN_ROOT) fail(`setRoot ${mem.setRoot} != golden ${KNOWN_ROOT}`);
if (mem.setId !== 'chemistry-known') fail(`setId ${mem.setId}`);
if (Number(num.threshold) !== 60000) fail(`numeric threshold not scaled: ${num.threshold}`);
console.log('OK   offline rows: numeric scaled, membership carries the golden setRoot, duplicate dropped');

// --- 3. Guards ----------------------------------------------------------------
step('Guards');
const expect400 = async (name, claims) => {
    const r = await http('POST', '/api/v1/producer/provePassportValuesBatch', {
        auth: PRODUCER, body: { passportId: pid, claimsJson: JSON.stringify(claims) }
    });
    if (r.status !== 400) fail(`${name}: expected 400, got ${r.status}: ${pretty(r.body)}`);
    console.log(`OK   ${name} -> 400`);
};
await expect400('unknown set', [{ sourceField: 'cellChemistry', predicate: 'setMembership', setId: 'nope' }]);
await expect400('set on wrong field', [{ sourceField: 'capacityKwh', predicate: 'setMembership', setId: 'chemistry-known' }]);
const single = await http('POST', '/api/v1/producer/provePassportValue', {
    auth: PRODUCER, body: { passportId: pid, sourceField: 'cellChemistry', predicate: 'setMembership', threshold: 0 }
});
if (single.status !== 400) fail(`single action with setMembership: expected 400, got ${single.status}`);
console.log('OK   single action rejects setMembership -> 400');

// Non-member value: a passport whose chemistry is not in the list.
const pid2 = `${pid}-X`;
await http('POST', '/api/v1/producer/createPassport', {
    auth: PRODUCER,
    body: {
        passportJson: JSON.stringify({
            passportId: pid2, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'EV', model: 'MemCell X',
            batteries: [{ serialNumber: `SN-${pid2}`, cellChemistry: 'Unobtainium-ion', capacityKwh: 10 }]
        }),
        submit: false
    }
});
const nonMember = await http('POST', '/api/v1/producer/provePassportValuesBatch', {
    auth: PRODUCER,
    body: { passportId: pid2, claimsJson: JSON.stringify([{ sourceField: 'cellChemistry', predicate: 'setMembership', setId: 'chemistry-known' }]) }
});
if (nonMember.status !== 400) fail(`non-member: expected 400, got ${nonMember.status}: ${pretty(nonMember.body)}`);
console.log('OK   non-member value -> 400 before any proving');

// --- 4. recordWalletMembership -------------------------------------------------
step('recordWalletMembership');
const badRoot = await http('POST', '/api/v1/producer/recordWalletMembership', {
    auth: PRODUCER, body: { passportId: pid, sourceField: 'cellChemistry', setId: 'chemistry-known', setRoot: '0x12', txHash: '', result: false }
});
if (badRoot.status !== 400) fail(`bad setRoot: expected 400, got ${badRoot.status}`);
const recFail = await http('POST', '/api/v1/producer/recordWalletMembership', {
    auth: PRODUCER, body: { passportId: pid, sourceField: 'cellChemistry', setId: 'chemistry-known', setRoot: KNOWN_ROOT, txHash: '', result: false }
});
if (recFail.status !== 200 || recFail.body.status !== 'failed') fail(`record(result=false) -> ${recFail.status}: ${pretty(recFail.body)}`);
console.log('OK   bad setRoot -> 400; failed proof recorded honestly');

// --- 5. Ingest round-trip + explorer serialization -----------------------------
step('Ingest + anchorExplorer');
const ingestPid = `${pid}-ING`;
const ing = await http('POST', '/api/v1/passport/ingest', {
    bearer: INGEST_SECRET,
    body: {
        passportId: ingestPid, model: 'Ingested EV', manufacturerId: 'X', batteryCategory: 'EV',
        status: 'anchored', payloadHash: 'a'.repeat(64), contractAddress: 'b'.repeat(64), anchorNetwork: 'preprod',
        claims: [
            { sourceField: 'carbonFootprintKgCO2', predicate: 'lessOrEqual', threshold: 4, unit: 'kg', txHash: 'c'.repeat(64) },
            { sourceField: 'cellChemistry', predicate: 'setMembership', setRoot: KNOWN_ROOT, setId: 'chemistry-known', txHash: 'c'.repeat(64) },
            { sourceField: 'cellChemistry', predicate: 'setMembership', setRoot: 'not-hex' } // malformed: dropped
        ]
    }
});
if (ing.status >= 300) fail(`ingest -> ${ing.status}: ${pretty(ing.body)}`);
const explorer = await http('GET', '/api/v1/passport/anchorExplorer()');
const ingRow = (explorer.body?.value ?? explorer.body ?? []).find((r) => r.passportId === ingestPid);
if (!ingRow) fail('ingested row not on the explorer');
if (ingRow.claims.length !== 2) fail(`expected 2 claims (malformed dropped), got ${pretty(ingRow.claims)}`);
const ingMem = ingRow.claims.find((c) => c.predicate === 'setMembership');
if (!ingMem || ingMem.setRoot !== KNOWN_ROOT || ingMem.setId !== 'chemistry-known') fail(`membership claim wrong: ${pretty(ingMem)}`);
if (!Array.isArray(ingMem.allowedValues) || !ingMem.allowedValues.includes('Li-ion NMC')) {
    fail(`allowedValues not published: ${pretty(ingMem.allowedValues)}`);
}
if (!ingMem.setLabel || ingMem.setLabel === 'chemistry-known') fail(`setLabel not resolved: ${ingMem.setLabel}`);
console.log('OK   ingest round-trip; explorer publishes setRoot + setLabel + allowedValues, malformed dropped');

// --- 6. Verify degrades honestly ----------------------------------------------
step('verifyMembershipClaimOnChain (no chain)');
const ver = await http('GET',
    `/api/v1/passport/verifyMembershipClaimOnChain(passportId=${q(ingestPid)},sourceField=${q('cellChemistry')},setRoot=${q(KNOWN_ROOT)})`);
if (ver.status !== 200 || ver.body.verified !== false) fail(`expected verified:false, got ${ver.status}: ${pretty(ver.body)}`);
const badVer = await http('GET',
    `/api/v1/passport/verifyMembershipClaimOnChain(passportId=${q(ingestPid)},sourceField=${q('cellChemistry')},setRoot=${q('zz')})`);
if (badVer.status !== 400) fail(`bad setRoot: expected 400, got ${badVer.status}`);
console.log('OK   degrades to verified:false, bad setRoot -> 400');

console.log('\nPASS membership-claims e2e (chain-free)');
