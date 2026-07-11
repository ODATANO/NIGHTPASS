// Live on-chain e2e against a RUNNING NIGHTPASS server (preprod, real wallet).
//
//   npm start                                      (terminal 1, cds-tsx serve)
//   node --env-file=.env test/integration/live-anchor-e2e.mjs   (terminal 2)
//
// Two phases, selected by PASSPORT_CONTRACT_ADDRESS:
//
// Phase A (PASSPORT_CONTRACT_ADDRESS unset): wallet bring-up + contract deploy.
//   connectWallet -> connectWalletForSigning (await prewarm job) ->
//   registerForDustGeneration (poll; waits only if new UTXOs were registered) ->
//   deployContract(attestation-vault) -> prints the contract address.
//   Put that address into .env as PASSPORT_CONTRACT_ADDRESS, restart the
//   server, then run this script again for Phase B.
//
// Phase B (PASSPORT_CONTRACT_ADDRESS set): the actual passport anchor test.
//   connectWallet -> connectWalletForSigning (warm restore) ->
//   producer/createPassport(submit:true) returns mode=anchoring immediately;
//   the server anchors DETACHED (attest + bindPassport + contentRoot). This
//   script then polls the Passports row until status=anchored, prints the
//   per-step tx log, and crawler-free-confirms via verifyAttestationState.
//
// Env knobs:
//   NIGHTPASS_BASE            default http://localhost:4004
//   LACE_VIEWING_KEY          required (preprod viewing key)
//   LACE_MNEMONIC             required (BIP39 phrase; server does HD derivation)
//   LIVE_SKIP_DUST=1          skip dust registration (already registered)
//   LIVE_DUST_WAIT_SECONDS    default 120, wait after a fresh registration
//   LIVE_PREWARM_TIMEOUT_MIN  default 240 (cold sync upper bound)

// createPassport now returns immediately (the anchor runs detached), but the
// prewarm/getJobStatus polls can still be slow calls on a busy server. Disable
// undici's dispatcher-level 5 min headersTimeout so no long response gets
// killed regardless of the per-request AbortSignal (same workaround as
// NIGHTGATE's run-deploy-e2e.mjs).
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 }));

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const NG = `${BASE}/api/v1/nightgate`;
const PROD = `${BASE}/api/v1/producer`;
const VK = process.env.LACE_VIEWING_KEY;
const MNEMONIC = (process.env.LACE_MNEMONIC || '').trim();
const CONTRACT = (process.env.PASSPORT_CONTRACT_ADDRESS || '').trim();
const SKIP_DUST = process.env.LIVE_SKIP_DUST === '1';
const DUST_WAIT_S = parseInt(process.env.LIVE_DUST_WAIT_SECONDS || '120', 10);
const PREWARM_TIMEOUT_MS = parseInt(process.env.LIVE_PREWARM_TIMEOUT_MIN || '240', 10) * 60_000;
const POLL_MS = 5000;

// NIGHTPASS runs custom auth (srv/auth.js); nightgate wallet actions require an
// authenticated user and producer actions require the producer role.
const AUTH = 'Basic ' + Buffer.from('producer:producer').toString('base64');

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!VK) fail('LACE_VIEWING_KEY env var is required (run with node --env-file=.env)');
if (!MNEMONIC) fail('LACE_MNEMONIC env var is required (run with node --env-file=.env)');

async function post(base, path, body, timeoutMs = 30 * 60_000) {
    const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

async function get(base, path) {
    const r = await fetch(`${base}${path}`, { headers: { Authorization: AUTH } });
    if (!r.ok) fail(`GET ${path} -> ${r.status}: ${await r.text()}`);
    return r.json();
}

async function pollJob(sessionId, jobId, label, timeoutMs = PREWARM_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const r = await post(NG, '/getJobStatus', { jobId, sessionId }, 120_000);
        if (r.status !== 200) fail(`getJobStatus(${jobId}) -> HTTP ${r.status}: ${pretty(r.body)}`);
        const { status, result, errorCode, errorMessage } = r.body;
        if (status !== last) { process.stdout.write(`\n     [${label}] ${jobId.slice(0, 8)} status=${status}`); last = status; }
        else process.stdout.write('.');
        if (status === 'succeeded') { process.stdout.write('\n'); return result ? JSON.parse(result) : {}; }
        if (status === 'failed') { process.stdout.write('\n'); fail(`[${label}] job ${jobId} failed: ${errorCode} - ${errorMessage}`); }
        await new Promise(r2 => setTimeout(r2, POLL_MS));
    }
    fail(`[${label}] job ${jobId} did not finish within ${timeoutMs / 1000}s`);
}

async function waitForServer() {
    step('Waiting for NIGHTPASS server');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`${BASE}/api/v1/indexer/getHealth()`, { headers: { Authorization: AUTH } });
            if (r.ok) { console.log(`OK   server up: ${JSON.stringify(await r.json())}`); return; }
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 1000));
    }
    fail(`server at ${BASE} did not respond within 60s (start it with: npm start)`);
}

async function connectSigningSession() {
    step('connectWallet (read-only session)');
    let r = await post(NG, '/connectWallet', { viewingKey: VK }, 120_000);
    if (r.status !== 200 && r.status !== 201) fail(`connectWallet -> HTTP ${r.status}: ${pretty(r.body)}`);
    const sessionId = r.body?.sessionId;
    if (!sessionId) fail(`connectWallet returned no sessionId: ${pretty(r.body)}`);
    console.log(`OK   sessionId = ${sessionId}`);

    step('connectWalletForSigning (mnemonic; kicks off facade prewarm)');
    r = await post(NG, '/connectWalletForSigning', { sessionId, mnemonic: MNEMONIC }, 10 * 60_000);
    if (r.status !== 200 && r.status !== 201) fail(`connectWalletForSigning -> HTTP ${r.status}: ${pretty(r.body)}`);
    console.log(`OK   signing enabled: ${pretty(r.body)}`);

    const prewarmJobId = r.body?.prewarmJobId;
    if (prewarmJobId) {
        step(`Waiting for prewarm ${prewarmJobId.slice(0, 8)} (warm restore expected; cold sync can take hours)`);
        await pollJob(sessionId, prewarmJobId, 'prewarm');
        console.log('OK   facade prewarm complete');
    } else {
        console.log('WARN no prewarmJobId - first action pays sync cost inline');
    }
    return sessionId;
}

async function phaseA(sessionId) {
    if (!SKIP_DUST) {
        step('registerForDustGeneration');
        const r = await post(NG, '/registerForDustGeneration', { sessionId, dustReceiverAddress: '' }, 10 * 60_000);
        if (r.status !== 200 && r.status !== 201) fail(`registerForDustGeneration -> HTTP ${r.status}: ${pretty(r.body)}`);
        const reg = await pollJob(sessionId, r.body.jobId, 'dust-reg');
        console.log(`OK   result: ${pretty(reg)}`);
        if (reg.registeredCount > 0) {
            step(`Waiting ${DUST_WAIT_S}s for first DUST accrual`);
            await new Promise(r2 => setTimeout(r2, DUST_WAIT_S * 1000));
        } else {
            console.log('     no UTXOs needed registering; DUST already accruing.');
        }
    }

    step('deployContract(attestation-vault)');
    const r = await post(NG, '/deployContract', {
        compiledArtifactRef: 'attestation-vault', sessionId, initialPrivateState: '{}'
    }, 10 * 60_000);
    if (r.status >= 400) fail(`deployContract -> HTTP ${r.status}: ${pretty(r.body)}`);
    const dep = await pollJob(sessionId, r.body.jobId, 'deploy');
    console.log(`OK   result: ${pretty(dep)}`);
    if (!dep.contractAddress) fail(`deploy returned no contractAddress: ${pretty(dep)}`);

    console.log('\nPHASE A PASSED. AttestationVault deployed on preprod.');
    console.log(`Tx hash:          ${dep.txHash}`);
    console.log(`Contract address: ${dep.contractAddress}`);
    console.log('\nNext: add to .env ->');
    console.log(`PASSPORT_CONTRACT_ADDRESS=${dep.contractAddress}`);
    console.log('then restart the server and re-run this script for Phase B.');
}

async function phaseB(sessionId) {
    // runTag makes BOTH the passportId AND the private payload unique per run.
    // The payload hash is computed over the batteries/recycledMaterials/
    // diligenceDocs content only; a constant payload would hit the vault's
    // "already attested" assert on every run after the first.
    const runTag = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const passportId = `BAT-LIVE-${runTag}`;
    step(`createPassport(${passportId}, submit:true) - server anchors detached`);
    const r = await post(PROD, '/createPassport', {
        submit: true,
        sessionId,
        passportJson: JSON.stringify({
            passportId, manufacturerId: 'DE-CELLCO-001', batteryCategory: 'EV',
            model: 'PowerCell EV-75', manufactureDate: '2026-07-01', weightKg: 432.5, performanceClass: 'B',
            batteries: [{ serialNumber: `SN-LIVE-${runTag}`, cellChemistry: 'NMC-811', capacityKwh: 75, carbonFootprintKgCO2: 3412.75, supplierName: 'CathodeWorks' }],
            recycledMaterials: [{ material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt' }],
            diligenceDocs: [{ docType: 'dd-report' }]
        })
    });
    if (r.status >= 400) fail(`createPassport -> HTTP ${r.status}: ${pretty(r.body)}`);
    console.log(`OK   response: ${pretty(r.body)}`);
    if (r.body?.mode !== 'anchoring') fail(`expected mode=anchoring, got '${r.body?.mode}' (is PASSPORT_CONTRACT_ADDRESS set in the SERVER's env?)`);

    step('Poll passport row until anchored (attest + bindPassport + contentRoot; expect ~1-3 min)');
    const rowUrl = `/Passports?$filter=passportId eq '${passportId}'&$select=ID,passportId,status,attestationTxHash,payloadHash,contractAddress`;
    const deadline = Date.now() + 20 * 60_000;
    let row = null;
    let lastStatus = null;
    while (Date.now() < deadline) {
        row = (await get(PROD, rowUrl)).value?.[0];
        const status = row?.status ?? '(no row yet)';
        if (status !== lastStatus) { process.stdout.write(`\n     [anchor] status=${status}`); lastStatus = status; }
        else process.stdout.write('.');
        if (status === 'anchored' || status === 'failed') break;
        await new Promise(r2 => setTimeout(r2, POLL_MS));
    }
    process.stdout.write('\n');
    if (!row) fail('passport row not found after createPassport');

    step('Transaction log');
    const txs = await get(PROD, `/PassportTransactions?$filter=passport_ID eq ${row.ID}&$select=kind,status,txHash,errorMessage`);
    for (const t of txs.value ?? []) console.log(`  tx: ${t.kind.padEnd(18)} ${t.status.padEnd(10)} ${t.txHash ?? t.errorMessage ?? ''}`);
    if (row.status !== 'anchored') fail(`passport status is '${row.status}' (expected 'anchored')`);
    if (!/^[0-9a-f]{64}$/i.test(String(row.attestationTxHash ?? ''))) fail(`expected a 64-hex attestationTxHash, got '${row.attestationTxHash}'`);

    step('Crawler-free on-chain confirm: verifyAttestationState');
    // OData FUNCTION (GET with inline parameters), not an action: POST gets 405.
    const v = await get(NG, `/verifyAttestationState(contractAddress='${row.contractAddress}',payloadHash='${row.payloadHash}',compiledArtifactRef='attestation-vault')`);
    console.log(`verifyAttestationState -> ${pretty(v)}`);
    if (v?.verified !== true) fail('on-chain state did NOT confirm the attested payload hash');

    console.log('\nPHASE B PASSED. Passport anchored on preprod and state-verified crawler-free.');
    console.log(`Passport:  ${passportId}`);
    console.log(`Attest tx: ${row.attestationTxHash}`);
}

(async () => {
    await waitForServer();
    const sessionId = await connectSigningSession();
    if (CONTRACT) await phaseB(sessionId); else await phaseA(sessionId);
    process.exit(0);
})().catch(e => fail(e?.message ?? String(e)));
