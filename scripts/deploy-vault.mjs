// Deploys a fresh attestation vault with the registrar wallet (PASSPORT_REGISTRAR_WALLET) as registrar. The NIGHTGATE API sponsors the fee.
// Run: node --env-file=.env --import tsx scripts/deploy-vault.mjs   (the grant needs `allowDeploy`)
import { randomUUID } from 'node:crypto';
import { createTxBuilder, deriveIdentity, waitLanded } from '@odatano/nightgate-tx/txbuilder';
import { connect } from '@odatano/nightgate-tx/client';
import { Contract } from '@odatano/nightgate-tx/attestation-vault';
import { producerSeedHex, producerWalletSecrets } from '../srv/lib/producer-wallets.ts';

function need(key) {
    const value = (process.env[key] ?? '').trim();
    if (!value) { console.error(`${key} is not set`); process.exit(1); }
    return value;
}
const apiUrl = need('NIGHTGATE_API_URL').replace(/\/$/, '');
const agentToken = need('NIGHTGATE_AGENT_TOKEN');
const registrarWallet = (process.env.PASSPORT_REGISTRAR_WALLET ?? '').trim() || 'default';
const registrar = producerWalletSecrets(registrarWallet);
if (!registrar) { console.error(`the registrar wallet '${registrarWallet}' has no mnemonic configured`); process.exit(1); }
const networkId = (process.env.NIGHTGATE_NETWORK ?? '').trim() || 'preprod';
const proofServerUrl = (process.env.NIGHTGATE_PROOF_SERVER_URL ?? '').trim();
// 64 hex; optional, default none; the attester that may re-point the registrar.
const recoveryId = (process.env.PASSPORT_RECOVERY_ATTESTER_ID ?? '').trim();

if (recoveryId && !/^[0-9a-f]{64}$/i.test(recoveryId)) { console.error('PASSPORT_RECOVERY_ATTESTER_ID must be 64 hex chars'); process.exit(1); }

const seedHex = producerSeedHex(registrar.mnemonic);
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const { attesterId } = await deriveIdentity({ seedHex, networkId });
console.log(`network ${networkId}, registrar wallet '${registrar.id}' ${attesterId}, recovery ${recoveryId || '(none)'}`);

const ng = await connect({ baseUrl: apiUrl, agentToken, timeoutMs: 180_000, pollMs: 4000 });
const builder = await createTxBuilder({
    seedHex, networkId, api: ng, walletSync: false,
    contractClass: Contract, contractName: 'attestation-vault',
    zkConfigBaseUrl: `${apiUrl}/zk-config/attestation-vault`,
    ...(proofServerUrl ? { provingMode: 'server', proofServerUrl } : {})
});
try {
    const built = await builder.buildDeploySponsorable({
        constructorArgs: [bytes(attesterId), recoveryId ? bytes(recoveryId) : new Uint8Array(32)],
        bind: false
    });
    console.log(`built ${built.serializedBytes} bytes, vault address ${built.contractAddress}`);
    const job = await ng.sponsorUnbound({ unboundTxB64: built.unboundTxB64, idempotencyKey: randomUUID() });
    const txId = String(job?.txHash ?? '');
    if (!txId) throw new Error(`sponsor job ${job?.jobId ?? '?'} returned no transaction`);
    const landed = await waitLanded(txId, { api: ng, timeoutMs: 240_000, pollMs: 5_000 });
    if (!landed) throw new Error(`transaction ${txId} was sponsored, but the API has not indexed it after 240 s`);
    if (landed.applied === false) throw new Error(`transaction ${txId} landed with status ${landed.status}`);
    console.log(`\ndeployed. PASSPORT_CONTRACT_ADDRESS=${built.contractAddress}`);
    console.log('Add the address to the sponsor policy of the API and to the grant before the first anchor.');
} finally {
    await builder.close().catch(() => { /* already closed */ });
}
