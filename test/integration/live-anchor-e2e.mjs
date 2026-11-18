// Live on-chain anchor e2e against a RUNNING NIGHTPASS server.
//
//   npm start                                                   (terminal 1)
//   node --env-file=.env test/integration/live-anchor-e2e.mjs   (terminal 2)
//
// The server signs with its default server wallet and hands the anchor to the
// NIGHTGATE API. It needs NIGHTGATE_API_URL, NIGHTGATE_AGENT_TOKEN,
// PASSPORT_CONTRACT_ADDRESS and PRODUCER_WALLET_MNEMONIC.
//
// Env of this script:
//   NIGHTPASS_BASE     default http://localhost:4004
//   NIGHTGATE_API_URL  required; its public verify service confirms the anchor

const BASE = process.env.NIGHTPASS_BASE || 'http://localhost:4004';
const PROD = `${BASE}/api/v1/producer`;
const API = (process.env.NIGHTGATE_API_URL || '').trim().replace(/\/$/, '');
const POLL_MS = 5000;

// NIGHTPASS runs custom auth (srv/auth.js); producer actions require the producer role.
const AUTH = 'Basic ' + Buffer.from('producer:producer').toString('base64');

function fail(msg) { console.error(`\nFAIL ${msg}`); process.exit(1); }
function step(name) { console.log(`\n--- ${name} ---`); }
function pretty(o) { return JSON.stringify(o, null, 2); }

if (!API) fail('NIGHTGATE_API_URL env var is required (run with node --env-file=.env)');

async function post(base, path, body) {
    const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: AUTH },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
    });
    const text = await r.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

async function get(url, headers = { Authorization: AUTH }) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) fail(`GET ${url} -> ${r.status}: ${await r.text()}`);
    return r.json();
}

async function waitForServer() {
    step(`Waiting for NIGHTPASS at ${BASE}`);
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`${PROD}/listServerWallets()`, { headers: { Authorization: AUTH } });
            if (r.ok) {
                const wallets = (await r.json()).value ?? [];
                console.log(`OK   server up, wallets: ${wallets.map((w) => `${w.id}${w.signingReady ? '' : ' (no secret)'}`).join(', ') || '(none)'}`);
                return;
            }
        } catch { /* booting */ }
        await new Promise((r2) => setTimeout(r2, 2000));
    }
    fail('server did not come up within 2 minutes');
}

async function anchor() {
    // runTag makes BOTH the passportId AND the private payload unique per run.
    // The payload hash covers the child rows only, and a constant payload
    // would hit the vault's "already attested" assert on every later run.
    const runTag = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const passportId = `BAT-LIVE-${runTag}`;
    step(`createPassport(${passportId}, submit:true) - server anchors detached`);
    const r = await post(PROD, '/createPassport', {
        submit: true,
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
    if (r.body?.mode !== 'anchoring') {
        fail(`expected mode=anchoring, got '${r.body?.mode}' (the SERVER needs the API access, a vault and a wallet mnemonic)`);
    }
    const contentRoot = String(r.body?.contentRoot ?? '');
    if (!/^[0-9a-f]{64}$/i.test(contentRoot)) fail(`expected a 64-hex contentRoot in the createPassport response, got '${contentRoot}'`);

    step('Poll passport row until anchored (attest + content root + binding in one transaction)');
    const rowUrl = `${PROD}/Passports?$filter=passportId eq '${passportId}'&$select=ID,passportId,status,attestationTxHash,payloadHash,contractAddress,attesterId`;
    const deadline = Date.now() + 20 * 60_000;
    let row = null;
    let lastStatus = null;
    while (Date.now() < deadline) {
        row = (await get(rowUrl)).value?.[0];
        const status = row?.status ?? '(no row yet)';
        if (status !== lastStatus) { process.stdout.write(`\n     [anchor] status=${status}`); lastStatus = status; }
        else process.stdout.write('.');
        if (status === 'anchored' || status === 'failed') break;
        await new Promise((r2) => setTimeout(r2, POLL_MS));
    }
    process.stdout.write('\n');
    if (!row) fail('passport row not found after createPassport');

    step('Transaction log');
    const txs = await get(`${PROD}/PassportTransactions?$filter=passport_ID eq ${row.ID}&$select=kind,status,txHash,errorMessage`);
    for (const t of txs.value ?? []) console.log(`  tx: ${t.kind.padEnd(18)} ${t.status.padEnd(10)} ${t.txHash ?? t.errorMessage ?? ''}`);
    if (row.status !== 'anchored') fail(`passport status is '${row.status}' (expected 'anchored')`);
    if (!/^[0-9a-f]{64}$/i.test(String(row.attestationTxHash ?? ''))) fail(`expected a 64-hex attestationTxHash, got '${row.attestationTxHash}'`);

    step('On-chain confirm through the public verify service of the NIGHTGATE API');
    // The anchored content root goes along, so the Merkle root is checked too.
    const v = await get(`${API}/odata/v4/midnight-verify/verifyAttestationState(contractAddress='${row.contractAddress}',attesterId='${row.attesterId}',payloadHash='${row.payloadHash}',contentRoot='${contentRoot}',compiledArtifactRef='attestation-vault')`, {});
    console.log(`verifyAttestationState -> ${pretty(v)}`);
    if (v?.verified !== true) fail('on-chain state did NOT confirm the attested payload hash');
    if (v?.contentRootOk !== true) fail(`anchored content root did NOT match (contentRootOk=${v?.contentRootOk}); anchored root ${contentRoot}`);

    step('The same through NIGHTPASS: verifyOnChain');
    const own = await get(`${BASE}/api/v1/passport/verifyOnChain(passportId='${passportId}')`, {});
    console.log(`verifyOnChain -> ${pretty(own)}`);
    if (own?.verified !== true) fail('verifyOnChain did not confirm the anchor');

    console.log('\nPASSED. Passport anchored and verified on chain.');
    console.log(`Passport:  ${passportId}`);
    console.log(`Attest tx: ${row.attestationTxHash}`);
}

(async () => {
    await waitForServer();
    await anchor();
    process.exit(0);
})().catch((e) => fail(e?.message ?? String(e)));
