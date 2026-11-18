// Repeats the passport id registrations on the current vault after a vault redeploy, signed by the registrar wallet (PASSPORT_REGISTRAR_WALLET).
// Run: node --env-file=.env --import tsx scripts/reregister-passport-ids.mjs   (reports; --apply sends one transaction per passport)
import { randomUUID } from 'node:crypto';
import cds from '@sap/cds';
import { createTxBuilder, waitLanded } from '@odatano/nightgate-tx/txbuilder';
import { connect } from '@odatano/nightgate-tx/client';
import { prepareRegisterDocument } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault';
import { producerSeedHex, producerWalletSecrets } from '../srv/lib/producer-wallets.ts';

function need(key) {
    const value = (process.env[key] ?? '').trim();
    if (!value) { console.error(`${key} is not set`); process.exit(1); }
    return value;
}
const apply = process.argv.includes('--apply');
const contractAddress = need('PASSPORT_CONTRACT_ADDRESS').toLowerCase();

const { SELECT } = cds.ql;
await cds.connect.to('db');
// The newest settled registration of each passport names the attester its id belongs to.
const registrations = await SELECT.from('passport.PassportTransactions')
    .columns('passport_ID', 'identifier', 'createdAt')
    .where({ kind: 'registerPassport', status: 'succeeded' })
    .orderBy('createdAt asc');
const ownerOf = new Map(registrations.filter((r) => /^[0-9a-f]{64}$/i.test(String(r.identifier ?? ''))).map((r) => [r.passport_ID, String(r.identifier).toLowerCase()]));
const passports = ownerOf.size
    ? await SELECT.from('passport.Passports').columns('ID', 'passportId', 'passportIdHash').where({ ID: { in: [...ownerOf.keys()] } })
    : [];
const work = passports.filter((p) => /^[0-9a-f]{64}$/i.test(String(p.passportIdHash ?? '')))
    .map((p) => ({ passportId: p.passportId, documentId: String(p.passportIdHash).toLowerCase(), ownerId: ownerOf.get(p.ID) }));

console.log(`vault ${contractAddress}: ${work.length} passport id(s) to register`);
for (const w of work) console.log(`  ${w.passportId} -> attester ${w.ownerId.slice(0, 16)}…`);
if (!apply || !work.length) {
    if (work.length) console.log('\nDry run. Run again with --apply to send.');
    process.exit(0);
}

const apiUrl = need('NIGHTGATE_API_URL').replace(/\/$/, '');
const registrarWallet = (process.env.PASSPORT_REGISTRAR_WALLET ?? '').trim() || 'default';
const registrar = producerWalletSecrets(registrarWallet);
if (!registrar) { console.error(`the registrar wallet '${registrarWallet}' has no mnemonic configured`); process.exit(1); }
const proofServerUrl = (process.env.NIGHTGATE_PROOF_SERVER_URL ?? '').trim();

const ng = await connect({ baseUrl: apiUrl, agentToken: need('NIGHTGATE_AGENT_TOKEN'), timeoutMs: 180_000, pollMs: 4000 });
const builder = await createTxBuilder({
    seedHex: producerSeedHex(registrar.mnemonic),
    networkId: (process.env.NIGHTGATE_NETWORK ?? '').trim() || 'preprod',
    api: ng, walletSync: false,
    contractClass: Contract, contractName: 'attestation-vault', circuits: ['registerDocument'],
    zkConfigBaseUrl: `${apiUrl}/zk-config/attestation-vault`,
    ...(proofServerUrl ? { provingMode: 'server', proofServerUrl } : {})
});
let failed = 0;
try {
    for (const w of work) {
        try {
            // Mode 0 assigns the document id to the attester.
            const call = prepareRegisterDocument({ mode: 0, documentId: w.documentId, ownerId: w.ownerId, attestationSecret: builder.attestationSecret });
            const built = await builder.buildSponsorable({ contractAddress, call, bind: false });
            const job = await ng.sponsorUnbound({ unboundTxB64: built.unboundTxB64, idempotencyKey: randomUUID() });
            const txId = String(job?.txHash ?? '');
            // The next build reads the state this transaction wrote, so wait until the API has indexed it.
            const landed = txId ? await waitLanded(txId, { api: ng, timeoutMs: 240_000, pollMs: 5_000 }) : null;
            if (!landed || landed.applied === false) throw new Error(`transaction ${txId || '(none)'} did not land`);
            console.log(`OK   ${w.passportId}: ${txId}`);
        } catch (e) {
            failed++;
            console.log(`FAIL ${w.passportId}: ${String(e?.message ?? e).slice(0, 200)}`);
        }
    }
} finally {
    await builder.close().catch(() => { /* already closed */ });
}
process.exit(failed ? 1 : 0);
