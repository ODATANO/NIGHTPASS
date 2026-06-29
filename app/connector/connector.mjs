// NIGHTPASS wallet-connector flow (Lace) — bundled to app/connector/dist by esbuild.
//
// Uses NIGHTGATE's verified browser building blocks (@odatano/nightgate/browser)
// + the DApp-Connector wallet (window.midnight, e.g. Lace) to attest / grant /
// revoke on the AttestationVault — the human-attester path. attest+grant+revoke
// all run with the SAME wallet-derived attester secret, so a full self-contained
// cycle works (a server-created grant uses a different secret and would fail the
// on-chain "not attester" assert — Phase-0 cross-path caveat).
//
// Verified building blocks (NIGHTGATE Phases 1-4): manifest discovery,
// FetchZkConfigProvider, providers assembly, attester-secret derivation, typed
// call inputs. The FINAL prove+balance+submit round-trip
// (makeConnectorWalletAdapter) is the live-integration boundary — finalize it
// against real Lace + chain.

// Node-global polyfills for the browser. Parts of the Midnight SDK (tx/zswap
// serialization in the submit path) use Node's `Buffer`, which Vite does not
// polyfill automatically. Provide it globally before any SDK code runs.
import { Buffer as NodeBuffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = NodeBuffer;
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;

// NOTE: all heavy SDK/WASM imports are LAZY (loaded inside the action functions)
// so the page + wallet connect work even before any ZK artifact loads. Importing
// @odatano/nightgate/browser eagerly would pull ledger/runtime WASM at page load
// and a failure there would leave the page blank with no connect button.
const loadBrowserSdk = () => import('@odatano/nightgate/browser');
const loadVaultContract = () => import('@odatano/nightgate/browser/attestation-vault');

const NETWORK = 'preprod';
const CONTRACT = 'attestation-vault';
const PRIVATE_STATE_ID = 'attestationVaultPrivateState';

// Lace's getConfiguration() points the prover at the hosted
// https://proof-server.preprod.midnight.network, but that host omits the
// Access-Control-Allow-Origin header on the actual POST /prove response (only
// the preflight has it), so a browser fetch is blocked by CORS. A LOCAL proof
// server (docker midnightntwrk/proof-server, port 6300) does send ACAO on the
// real response, so we self-prove against it instead. Requires the local proof
// server to be running.
const LOCAL_PROVER_URL = 'http://localhost:6300';

/** Discover injected DApp-Connector wallets (window.midnight.*). */
export function listWallets() {
    const m = (typeof window !== 'undefined' && window.midnight) || {};
    return Object.entries(m).map(([key, api]) => ({ key, name: api?.name || key, rdns: api?.rdns, icon: api?.icon }));
}

/** Connect a wallet by its window.midnight key (e.g. 'mnLace'). */
export async function connect(walletKey) {
    const initial = window.midnight?.[walletKey];
    if (!initial) throw new Error(`wallet '${walletKey}' not found in window.midnight`);
    return initial.connect(NETWORK); // v4 ConnectedAPI
}

async function fetchManifest() {
    const res = await fetch('/contract-manifest');
    if (!res.ok) throw new Error(`/contract-manifest -> HTTP ${res.status}`);
    return res.json();
}

// App-managed attester secret.
//
// The Midnight DApp Connector (Lace v4) does NOT implement message signing —
// `api.signData(...)` throws `Method not implemented.` So the attester identity
// cannot be derived from a wallet signature (the FR open-question-#1 fallback:
// "else a consumer-owned secret"). We generate a random 32-byte secret once,
// persist it in localStorage keyed by the connected wallet's shielded address,
// and reuse it for attest/grant/revoke so they share one attester identity.
//
// Cross-path caveat (Phase 0): this identity differs from the server's
// seed-HMAC identity, so a server-created grant can't be revoked here and vice
// versa — run a full attest→grant→revoke cycle in-browser with the same wallet.
const STORE_PREFIX = 'nightgate:attester-secret:v1:';

function toHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
    return Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));
}

async function walletStoreKey(api) {
    try {
        const addrs = await api.getShieldedAddresses();
        const id = addrs && (addrs.shieldedAddress || addrs.shieldedCoinPublicKey);
        if (id) return STORE_PREFIX + id;
    } catch { /* fall through to default key */ }
    return STORE_PREFIX + 'default';
}

let _cachedSecret = null;
export async function deriveAttesterSecret(api) {
    if (_cachedSecret) return _cachedSecret;
    const { deriveAttestationSecret } = await loadBrowserSdk();
    const key = await walletStoreKey(api);
    let hex = (typeof localStorage !== 'undefined' && localStorage.getItem(key)) || null;
    if (!hex) {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        hex = toHex(buf);
        try { localStorage.setItem(key, hex); } catch { /* private mode: in-memory only */ }
    }
    _cachedSecret = deriveAttestationSecret(fromHex(hex));
    return _cachedSecret;
}

// --- LIVE-INTEGRATION BOUNDARY (finalize against Lace) ----------------------
// Adapts the v4 connector (serialized tx strings) to midnight-js
// WalletProvider/MidnightProvider (typed ledger objects). The exact ledger
// serialize/deserialize boundary + whether balanceUnsealed vs balanceSealed is
// correct MUST be confirmed against a real Lace + chain.
// Short, safe description of a value for diagnostic logging.
function describe(x) {
    if (x === null) return 'null';
    if (x === undefined) return 'undefined';
    const t = typeof x;
    if (t === 'string') return `string(${x.length} chars)`;
    if (t !== 'object') return `${t}(${String(x)})`;
    const ctor = x.constructor && x.constructor.name;
    let keys = '?';
    try { keys = Object.keys(x).slice(0, 10).join(','); } catch {}
    const len = (x instanceof Uint8Array || Array.isArray(x)) ? ` len=${x.length}` : '';
    return `object ctor=${ctor}${len} keys=[${keys}]`;
}

function makeConnectorWalletAdapter(api, walletKeys, ledger, log) {
    return {
        getCoinPublicKey() { return walletKeys.coinPublicKey; },
        getEncryptionPublicKey() { return walletKeys.encryptionPublicKey; },
        async balanceTx(tx /*, ttl */) {
            log(`balanceTx in: ${describe(tx)} serialize=${typeof tx?.serialize}`);
            const serialized = typeof tx?.serialize === 'function' ? tx.serialize() : tx;
            log(`balanceTx serialized: ${describe(serialized)}`);
            let res;
            try {
                res = await api.balanceUnsealedTransaction(serialized);
            } catch (e) {
                log(`balanceUnsealedTransaction THREW: name=${e?.name} msg=${e?.message || '(empty)'} code=${e?.code}`);
                // Lace wraps errors in an Effect-ts FiberFailure; the real cause is
                // nested. toString()/stack usually pretty-print it; also walk .cause.
                try { log('  toString: ' + String(e)); } catch {}
                try { log('  stack: ' + String(e?.stack || '').split('\n').slice(0, 5).join(' | ')); } catch {}
                let c = e?.cause, depth = 0;
                while (c && depth < 8) {
                    const real = c.error ?? c.defect ?? c.failure ?? c.value;
                    log(`  cause[${depth}] tag=${c._tag ?? c._id} ${real != null ? 'err=' + (real.message ?? String(real)) : ''}`);
                    c = c.cause ?? c.error ?? c.defect ?? c.failure ?? c.left ?? c.right;
                    depth++;
                }
                throw e;
            }
            log(`balanceUnsealedTransaction returned: ${describe(res)}`);
            // Lace returns the balanced tx as { tx: <serialized string> }. The SDK
            // passes balanceTx's result straight to submitTx (submitTxCore calls no
            // ledger methods on it), so we pass the serialized form through as-is
            // rather than deserializing into a Transaction object and re-serializing.
            const balanced = (res && typeof res === 'object' && 'tx' in res) ? res.tx : res;
            log(`balanceTx out (passthrough): ${describe(balanced)}`);
            return balanced;
        },
        async submitTx(tx) {
            log(`submitTx in: ${describe(tx)} serialize=${typeof tx?.serialize}`);
            const serialized = typeof tx?.serialize === 'function' ? tx.serialize() : tx;
            const res = await api.submitTransaction(serialized);
            log(`submitTransaction returned: ${describe(res)}`);
            // submitTx must return a TransactionId. Prefer Lace's return value.
            return res ?? serialized;
        }
    };
}

/**
 * Shared path: assemble providers, find the deployed vault bound with the
 * prepared call's witnesses, and invoke the circuit. `call` comes from one of
 * the prepare* helpers ({ circuitId, args, witnesses }).
 */
async function runPreparedCall(api, contractAddress, call, log) {
    if (!contractAddress) throw new Error('contractAddress is required (the deployed vault address)');

    log('fetching manifest…');
    const manifest = await fetchManifest();

    log('assembling providers (zk-config from /zk-config, indexer from wallet)…');
    const { createNightgateConnectorProviders } = await loadBrowserSdk();
    const providers = await createNightgateConnectorProviders({ connector: api, manifest, contract: CONTRACT });
    log(`indexer: ${providers.config?.indexerUri} (ws ${providers.config?.indexerWsUri})`);
    log(`prover: ${providers.config?.proverServerUri ?? '(none, wallet-delegated)'}`);
    log(`wallet: ${providers.walletKeys?.shieldedAddress ?? '(no address)'}`);

    log('loading SDK (contracts + ledger)…');
    const [{ findDeployedContract }, ledger, { Contract }, { CompiledContract }, networkIdMod, proofMod] = await Promise.all([
        import('@midnight-ntwrk/midnight-js-contracts'),
        import('@midnight-ntwrk/ledger-v8'),
        loadVaultContract(),
        import('@midnight-ntwrk/compact-js'),
        import('@midnight-ntwrk/midnight-js-network-id'),
        import('@midnight-ntwrk/midnight-js-http-client-proof-provider')
    ]);

    // The SDK keeps the active network as process-global state; every
    // wallet/contract call reads it via getNetworkId() and throws if unset.
    // Source it from the connector's own configuration (Lace's network).
    const networkId = providers.config?.networkId;
    if (networkId == null) throw new Error('connector did not report a networkId');
    networkIdMod.setNetworkId(networkId);
    log(`network id set: ${networkId}`);

    // Self-prove against the local proof server (CORS-clean), overriding the
    // hosted one the connector reported (see LOCAL_PROVER_URL note).
    const proofProvider = proofMod.httpClientProofProvider(LOCAL_PROVER_URL, providers.zkConfigProvider);
    log(`prover override: ${LOCAL_PROVER_URL}`);

    const walletAdapter = makeConnectorWalletAdapter(api, providers.walletKeys, ledger, log);
    const fullProviders = {
        publicDataProvider: providers.publicDataProvider,
        zkConfigProvider: providers.zkConfigProvider,
        proofProvider,
        privateStateProvider: providers.privateStateProvider,
        walletProvider: walletAdapter,
        midnightProvider: walletAdapter
    };

    log(`finding deployed contract for ${call.circuitId}…`);
    // midnight-js-contracts@4.1.0 expects a compact-js `CompiledContract`
    // (tagged + witnesses), not a raw `new Contract(witnesses)` instance. Wrap
    // our classic compactc artifact: make(tag, ctor) attaches the constructor,
    // withWitnesses attaches the witnesses — the SDK then does
    // `new ctor(witnesses)` internally. (Without this the SDK passes `undefined`
    // to compact-js getContractContext → "reading 'Symbol()'" crash.)
    const compiledContract = CompiledContract.withWitnesses(
        CompiledContract.make(CONTRACT, Contract),
        call.witnesses
    );
    // AttestationVault has NO contract private state (all ledger is public,
    // witnesses pass ctx.privateState through). We still must seed a DEFINED
    // value: both findDeployedContract and the callTx scoped transaction read
    // the private state and assertDefined rejects null/undefined. An empty
    // object satisfies that and flows through the witnesses unchanged.
    await fullProviders.privateStateProvider.set(PRIVATE_STATE_ID, {});
    const deployed = await findDeployedContract(fullProviders, {
        contractAddress, compiledContract,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: {}
    });

    log(`submitting ${call.circuitId} (prove + balance + submit via wallet)…`);
    const result = await deployed.callTx[call.circuitId](...call.args);
    log(`submitted ${call.circuitId}: ${JSON.stringify(result?.public?.txId ?? result)}`);
    return result;
}

function mklog(log) {
    return (m) => { try { log(m); } catch {} console.log('[connector] ' + m); };
}

/** attest(payload_hash, metadata_hash) */
export async function attest(api, { contractAddress, payloadHash, metadataHash }, log = console.log) {
    const L = mklog(log);
    L('attest: loading browser SDK (first call downloads ~10MB WASM, please wait)…');
    const { prepareAttest } = await loadBrowserSdk();
    L('attest: deriving app-managed attester secret (no wallet popup)…');
    const attestationSecret = await deriveAttesterSecret(api);
    return runPreparedCall(api, contractAddress, prepareAttest({ payloadHash, metadataHash, attestationSecret }), L);
}

/** grantDisclosure(payload_hash, grantee, level) — level 0=public,1=legit,2=authority */
export async function grantDisclosure(api, { contractAddress, payloadHash, grantee, level }, log = console.log) {
    const L = mklog(log);
    L('grant: loading browser SDK…');
    const { prepareGrantDisclosure } = await loadBrowserSdk();
    L('grant: deriving app-managed attester secret (no wallet popup)…');
    const attestationSecret = await deriveAttesterSecret(api);
    return runPreparedCall(api, contractAddress, prepareGrantDisclosure({ payloadHash, grantee, level, attestationSecret }), L);
}

/** revokeDisclosure(payload_hash, grantee) */
export async function revokeDisclosure(api, { contractAddress, payloadHash, grantee }, log = console.log) {
    const L = mklog(log);
    L('revoke: loading browser SDK…');
    const { prepareRevokeDisclosure } = await loadBrowserSdk();
    L('revoke: deriving app-managed attester secret (no wallet popup)…');
    const attestationSecret = await deriveAttesterSecret(api);
    return runPreparedCall(api, contractAddress, prepareRevokeDisclosure({ payloadHash, grantee, attestationSecret }), L);
}
