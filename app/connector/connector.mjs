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

const NETWORK = 'preview';
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

// Fallback Preview indexer for on-chain verification when no wallet config has
// been seen yet. Overridden at runtime by the connector's reported indexerUri
// (so verification follows whatever network the wallet is on).
const PREVIEW_INDEXER_HTTP = 'https://indexer.preview.midnight.network/api/v4/graphql';
let _lastIndexerUri = null;
let _lastSubmittedTxId = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The transaction identifier of the most recent submit (for chain verification). */
export function getLastTxId() { return _lastSubmittedTxId; }

// Stringify a value for diagnostic logging, surviving bigint.
function safeStr(x) {
    try { return JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch { return String(x); }
}
// Await a value that may be a plain value, a Promise, or an Observable.
async function resolveMaybe(v, log) {
    try {
        if (v && typeof v.then === 'function') return await v;
        if (v && typeof v.subscribe === 'function') {
            return await new Promise((resolve) => {
                let done = false; const finish = (x) => { if (!done) { done = true; resolve(x); } };
                const sub = v.subscribe({ next: (x) => { finish(x); try { sub?.unsubscribe?.(); } catch {} }, error: () => finish(null) });
                setTimeout(() => finish(null), 8000);
            });
        }
        return v;
    } catch (e) { log?.(`resolve error: ${e?.message || e}`); return null; }
}
// Coerce a scalar-ish balance value to a numeric string.
function coerceAmount(x) {
    if (x == null) return null;
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'number') return String(x);
    if (typeof x === 'string') return x;
    if (typeof x === 'object') {
        for (const k of ['balance', 'available', 'amount', 'value', 'total']) {
            if (x[k] != null) { const c = coerceAmount(x[k]); if (c != null) return c; }
        }
    }
    return null;
}
// Normalize a balances collection (Map | array of {tokenType,amount} | object map | scalar)
// into [tokenType, amount] entries.
function balanceEntries(x) {
    if (x == null) return [];
    if (x instanceof Map) return [...x.entries()];
    if (Array.isArray(x)) return x.map((e) => [e?.tokenType ?? e?.type ?? '?', e?.amount ?? e?.value ?? e?.balance ?? e]);
    const scalar = coerceAmount(x);
    if (scalar != null && !Object.values(x).some((v) => v && typeof v === 'object')) return [['native', scalar]];
    if (typeof x === 'object') return Object.entries(x);
    return [];
}

/**
 * Read the connected wallet's DUST + NIGHT balances via the Lace connector's
 * dedicated getters (getDustBalance / getUnshieldedBalances). Shapes are
 * runtime-injected, so each raw return is logged and parsed best-effort.
 * Returns { dust, night } (atomic-unit strings or null).
 */
export async function readWalletBalances(api, log = console.log) {
    const L = mklog(log);
    let dust = null, night = null;

    try {
        if (typeof api?.getDustBalance === 'function') {
            const d = await resolveMaybe(api.getDustBalance(), L);
            L(`getDustBalance → ${safeStr(d)}`);
            dust = coerceAmount(d);
            if (dust == null) { const e = balanceEntries(d); if (e.length) dust = coerceAmount(e[0][1]); }
        }
    } catch (e) { L(`getDustBalance error: ${e?.message || e}`); }

    try {
        if (typeof api?.getUnshieldedBalances === 'function') {
            const u = await resolveMaybe(api.getUnshieldedBalances(), L);
            L(`getUnshieldedBalances → ${safeStr(u)}`);
            const entries = balanceEntries(u);
            for (const [tt, amt] of entries) L(`  unshielded ${String(tt).slice(0, 28)} = ${safeStr(amt)}`);
            // NIGHT is the native unshielded token (all-zero token type), else the first / largest.
            const native = entries.find(([tt]) => /^(0x)?0*$/i.test(String(tt)) || /night/i.test(String(tt))) || entries[0];
            if (native) night = coerceAmount(native[1]);
        }
    } catch (e) { L(`getUnshieldedBalances error: ${e?.message || e}`); }

    L(`wallet balances → DUST=${dust ?? 'n/a'} NIGHT=${night ?? 'n/a'}`);
    return { dust, night };
}

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

/** Decode a serialized tx (hex or base64 string, or Uint8Array) to bytes. */
function txStringToBytes(s) {
    if (s instanceof Uint8Array) return s;
    if (typeof s !== 'string') throw new Error('cannot decode tx of type ' + typeof s);
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
        const out = new Uint8Array(s.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
        return out;
    }
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Recover a transaction's identifiers from its serialized (balanced) form. The
 * indexer's watchForTxData(txId) matches `offset.identifier` against a tx's
 * `identifiers`, so this is what submitTx must return — NOT the serialized tx.
 * A fully built+balanced contract tx is signature/proof/binding; we try a few
 * marker combos defensively. Returns null if none deserialize.
 */
function identifiersFromSerialized(ledger, serialized, log) {
    let bytes;
    try { bytes = txStringToBytes(serialized); } catch (e) { log(`txId decode failed: ${e?.message}`); return null; }
    const combos = [
        ['signature', 'proof', 'binding'],
        ['signature-erased', 'proof', 'binding'],
        ['signature', 'proof', 'no-binding']
    ];
    for (const [s, p, b] of combos) {
        try {
            const t = ledger.Transaction.deserialize(s, p, b, bytes);
            const ids = t.identifiers();
            if (ids && ids.length) { log(`deserialized balanced tx (${s}/${p}/${b}) -> ${ids.length} identifier(s)`); return ids; }
        } catch { /* try next marker combo */ }
    }
    return null;
}

function makeConnectorWalletAdapter(api, walletKeys, ledger, log) {
    // Captured from the proven (pre-balance) Transaction object the SDK hands to
    // balanceTx. The contract deploy/call identifier is balancing-independent, so
    // these survive into the balanced tx and serve as a fallback if we can't
    // deserialize Lace's balanced string.
    let preBalanceIdentifiers = null;
    return {
        getCoinPublicKey() { return walletKeys.coinPublicKey; },
        getEncryptionPublicKey() { return walletKeys.encryptionPublicKey; },
        async balanceTx(tx /*, ttl */) {
            log(`balanceTx in: ${describe(tx)} serialize=${typeof tx?.serialize}`);
            try { if (typeof tx?.identifiers === 'function') { preBalanceIdentifiers = tx.identifiers(); log(`pre-balance identifiers: ${preBalanceIdentifiers?.length}`); } } catch {}
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
            // The SDK watches by transaction IDENTIFIER, not the serialized tx.
            // Derive it from the balanced tx (Lace's submitTransaction returns
            // undefined). Returning the serialized tx here is what produced the
            // 29KB "txId" → indexer "Failed to fetch".
            let ids = identifiersFromSerialized(ledger, serialized, log);
            if ((!ids || !ids.length) && preBalanceIdentifiers?.length) {
                ids = preBalanceIdentifiers;
                log(`using pre-balance identifiers as fallback (${ids.length})`);
            }
            const txId = ids && ids[0];
            log(`watch txId: ${txId ?? '(none — watch will fail)'}`);
            let res;
            try {
                res = await api.submitTransaction(serialized);
            } catch (e) {
                log(`submitTransaction THREW: name=${e?.name} msg=${e?.message || '(empty)'}`);
                try { log('  toString: ' + String(e)); } catch {}
                throw e;
            }
            log(`submitTransaction returned: ${describe(res)}`);
            // submitTx must return a TransactionId. Prefer Lace's return value if
            // it's a real (short) id string; otherwise the derived identifier.
            if (typeof res === 'string' && res && res.length < 200) { _lastSubmittedTxId = res; return res; }
            if (txId) { _lastSubmittedTxId = txId; return txId; }
            throw new Error('submitTx: could not determine a transaction identifier to watch');
        }
    };
}

/**
 * Assemble providers + load the SDK + set the network + build the wallet adapter
 * and the witness-bound compiled contract. Shared by deploy and call. `witnesses`
 * is the AttestationVault witness object (attester secret, etc.) — for deploy it
 * binds the deployer identity, for a call it satisfies the circuit witnesses.
 */
async function prepareSdkContext(api, witnesses, log) {
    log('fetching manifest…');
    const manifest = await fetchManifest();

    log('assembling providers (zk-config from /zk-config, indexer from wallet)…');
    const { createNightgateConnectorProviders } = await loadBrowserSdk();
    const providers = await createNightgateConnectorProviders({ connector: api, manifest, contract: CONTRACT });
    _lastIndexerUri = providers.config?.indexerUri || _lastIndexerUri;
    log(`indexer: ${providers.config?.indexerUri} (ws ${providers.config?.indexerWsUri})`);
    log(`prover: ${providers.config?.proverServerUri ?? '(none, wallet-delegated)'}`);
    log(`wallet: ${providers.walletKeys?.shieldedAddress ?? '(no address)'}`);

    log('loading SDK (contracts + ledger)…');
    const [contracts, ledger, { Contract }, { CompiledContract }, networkIdMod, proofMod] = await Promise.all([
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

    // midnight-js-contracts@4.1.0 expects a compact-js `CompiledContract`
    // (tagged + witnesses), not a raw `new Contract(witnesses)` instance. Wrap
    // our classic compactc artifact: make(tag, ctor) attaches the constructor,
    // withWitnesses attaches the witnesses — the SDK then does
    // `new ctor(witnesses)` internally. (Without this the SDK passes `undefined`
    // to compact-js getContractContext → "reading 'Symbol()'" crash.)
    const compiledContract = CompiledContract.withWitnesses(
        CompiledContract.make(CONTRACT, Contract),
        witnesses
    );
    // AttestationVault has NO contract private state (all ledger is public,
    // witnesses pass ctx.privateState through). We still must seed a DEFINED
    // value: deploy, findDeployedContract and the callTx scoped transaction all
    // read the private state and assertDefined rejects null/undefined. An empty
    // object satisfies that and flows through the witnesses unchanged.
    await fullProviders.privateStateProvider.set(PRIVATE_STATE_ID, {});

    return { fullProviders, compiledContract, contracts };
}

/**
 * Shared path: assemble providers, find the deployed vault bound with the
 * prepared call's witnesses, and invoke the circuit. `call` comes from one of
 * the prepare* helpers ({ circuitId, args, witnesses }).
 */
async function runPreparedCall(api, contractAddress, call, log) {
    if (!contractAddress) throw new Error('contractAddress is required (the deployed vault address)');
    const { fullProviders, compiledContract, contracts } = await prepareSdkContext(api, call.witnesses, log);

    log(`finding deployed contract for ${call.circuitId}…`);
    const deployed = await contracts.findDeployedContract(fullProviders, {
        contractAddress, compiledContract,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: {}
    });

    log(`submitting ${call.circuitId} (prove + balance + submit via wallet)…`);
    const result = await deployed.callTx[call.circuitId](...call.args);
    log(`submitted ${call.circuitId}: ${JSON.stringify(result?.public?.txId ?? result)}`);
    return result;
}

/**
 * Deploy a fresh AttestationVault from the connected (funded) wallet. Returns
 * the deployed contract address. Uses the SAME app-managed attester secret as
 * attest/grant/revoke so the deployer-bound attester identity matches — a vault
 * deployed here can be attested + disclosure-managed by this same wallet.
 *
 * This is also the first real exercise of makeConnectorWalletAdapter's
 * prove→balance→submit path; if deploy lands on-chain the adapter boundary is
 * confirmed and the circuit calls follow the identical wallet round-trip.
 */
export async function deployVault(api, log = console.log) {
    const L = mklog(log);
    L('deploy: loading browser SDK (first call downloads ~10MB WASM, please wait)…');
    const { buildAttestationVaultWitnesses } = await loadBrowserSdk();
    L('deploy: deriving app-managed attester secret (binds the deployer identity)…');
    const attestationSecret = await deriveAttesterSecret(api);
    const witnesses = buildAttestationVaultWitnesses({ attestationSecret });
    const { fullProviders, compiledContract, contracts } = await prepareSdkContext(api, witnesses, L);

    L('deploying attestation-vault (prove + balance + submit via wallet)…');
    const result = await contracts.deployContract(fullProviders, {
        compiledContract,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: {}
    });
    const addr = result?.deployTxData?.public?.contractAddress
        ?? result?.public?.contractAddress
        ?? result?.contractAddress;
    L(`deployed attestation-vault at: ${addr ?? '(address not found in result)'}`);
    return { contractAddress: addr, result };
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

// --- Predicate Attestation (value ≤ / ≥ threshold, value stays off-chain) ----
// Two-step PAC flow on the AttestationVault:
//   1) commitValue(payload_hash)            — pins a Pedersen-style commitment to
//      the hidden value+salt on-chain (the value itself is a witness, never sent).
//   2) provePredicate(payload_hash, threshold, op) — proves value ≤ threshold
//      (op 0) or value ≥ threshold (op 1) against that commitment in-circuit; the
//      tx only lands if the assert holds, so a successful tx IS the proof, and
//      the chain records predicate_results[claim]=true WITHOUT the value.
// Both witness attested_value()+value_salt(), so the SAME value+salt must be used
// for commit and prove (and the payload must already be attested by this wallet).

/** commitValue(payload_hash) — attach a hidden numeric commitment. */
export async function commitValue(api, { contractAddress, payloadHash, value, valueSalt }, log = console.log) {
    const L = mklog(log);
    L('commitValue: loading browser SDK…');
    const { buildAttestationVaultWitnesses } = await loadBrowserSdk();
    L('commitValue: deriving app-managed attester secret…');
    const attestationSecret = await deriveAttesterSecret(api);
    const call = {
        circuitId: 'commitValue',
        args: [fromHex(payloadHash)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, witnessValues: { attestedValue: String(value), valueSalt } })
    };
    L(`committing hidden value (only its commitment goes on-chain)…`);
    return runPreparedCall(api, contractAddress, call, L);
}

/** provePredicate(payload_hash, threshold, op) — op 0 = value ≤ threshold, 1 = value ≥ threshold. */
export async function provePredicate(api, { contractAddress, payloadHash, value, valueSalt, threshold, op }, log = console.log) {
    const L = mklog(log);
    L('provePredicate: loading browser SDK…');
    const { buildAttestationVaultWitnesses } = await loadBrowserSdk();
    L('provePredicate: deriving app-managed attester secret…');
    const attestationSecret = await deriveAttesterSecret(api);
    const opNum = Number(op);
    const call = {
        circuitId: 'provePredicate',
        args: [fromHex(payloadHash), BigInt(threshold), BigInt(opNum)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, witnessValues: { attestedValue: String(value), valueSalt } })
    };
    L(`proving ${value} ${opNum === 0 ? '≤' : '≥'} ${threshold} in zero-knowledge (the value never leaves the browser)…`);
    const result = await runPreparedCall(api, contractAddress, call, L);
    L(`✓ predicate proven on-chain: ${value} ${opNum === 0 ? '≤' : '≥'} ${threshold} holds — verified without revealing ${value}.`);
    return result;
}

// --- Field-bound Predicate (value bound to a SPECIFIC passport field) --------
// Hardened flow that answers "is this the value from THIS passport?". The value
// is proven to be a leaf in a Merkle content-root anchored at attest time, so it
// can't be swapped for an arbitrary number:
//   1) anchorContentRoot(payload_hash, content_root) — pins the root over the
//      passport's provable fields (done once, typically right after attest).
//   2) proveFieldPredicate(payload_hash, field_key, threshold, op) — recomputes
//      the field's Merkle leaf from the witnessed value + inclusion path, asserts
//      it folds to the anchored root, THEN asserts the predicate. A successful tx
//      proves the predicate holds for THIS passport's field, value still hidden.

/** anchorContentRoot(payload_hash, content_root) — pin the field Merkle root. */
export async function anchorContentRoot(api, { contractAddress, payloadHash, contentRoot }, log = console.log) {
    const L = mklog(log);
    L('anchorContentRoot: loading browser SDK…');
    const { buildAttestationVaultWitnesses } = await loadBrowserSdk();
    L('anchorContentRoot: deriving app-managed attester secret…');
    const attestationSecret = await deriveAttesterSecret(api);
    const call = {
        circuitId: 'anchorContentRoot',
        args: [fromHex(payloadHash), fromHex(contentRoot)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    };
    L('anchoring content root (binds the passport fields for later field-bound proofs)…');
    return runPreparedCall(api, contractAddress, call, L);
}

/**
 * proveFieldPredicate(payload_hash, field_key, threshold, op) — field-bound proof.
 * `merkleProof` = { fieldValue (scaled decimal string), siblings (4 × 64-hex),
 * dirs (4 booleans) }. op 0 = value ≤ threshold, 1 = value ≥ threshold.
 */
export async function proveFieldPredicate(api, { contractAddress, payloadHash, fieldKey, threshold, op, fieldValue, siblings, dirs }, log = console.log) {
    const L = mklog(log);
    L('proveFieldPredicate: loading browser SDK…');
    const { buildAttestationVaultWitnesses } = await loadBrowserSdk();
    L('proveFieldPredicate: deriving app-managed attester secret…');
    const attestationSecret = await deriveAttesterSecret(api);
    const opNum = Number(op);
    const call = {
        circuitId: 'proveFieldPredicate',
        args: [fromHex(payloadHash), fromHex(fieldKey), BigInt(threshold), BigInt(opNum)],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret, merkleProof: { fieldValue: String(fieldValue), siblings, dirs } })
    };
    L(`proving field ${fieldValue} ${opNum === 0 ? '≤' : '≥'} ${threshold} — bound to this passport's content root, value hidden…`);
    const result = await runPreparedCall(api, contractAddress, call, L);
    L(`✓ field-bound predicate proven on-chain: the passport's own value ${opNum === 0 ? '≤' : '≥'} ${threshold} holds.`);
    return result;
}

// --- On-chain verification (indexer scan) -----------------------------------
// The verification model is indexer-trust: a tx that landed in a block with
// status SUCCESS is confirmed. Polls the Preview indexer (HTTP GraphQL) for the
// transaction by its identifier and reports status via onStatus(kind, text):
//   'scanning' (in progress) | 'ok' (found, SUCCESS) | 'fail' (failed / not found).
const VERIFY_TX_QUERY = `query VerifyTx($offset: TransactionOffset!) {
  transactions(offset: $offset) {
    hash
    block { height }
    ... on RegularTransaction { transactionResult { status } }
  }
}`;

export async function verifyTxOnChain(txId, opts = {}, log = console.log, onStatus = () => {}) {
    const L = mklog(log);
    if (!txId) { onStatus('fail', 'no tx id'); throw new Error('verifyTxOnChain: txId required'); }
    const url = opts.indexerUrl || _lastIndexerUri || PREVIEW_INDEXER_HTTP;
    const attempts = opts.attempts ?? 20;
    const delayMs = opts.delayMs ?? 2000;
    L(`verify: scanning chain for tx ${String(txId).slice(0, 18)}… via ${url}`);
    for (let i = 0; i < attempts; i++) {
        onStatus('scanning', `scanning chain… (${i + 1}/${attempts})`);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: VERIFY_TX_QUERY, variables: { offset: { identifier: txId } } })
            });
            const json = await res.json();
            const tx = (json?.data?.transactions || [])[0];
            if (tx) {
                const status = tx?.transactionResult?.status || 'UNKNOWN';
                const height = tx?.block?.height;
                const hash = tx?.hash; // 32-byte tx hash = the explorer's tx key (≠ identifier)
                if (/SUCCESS/i.test(status)) {
                    onStatus('ok', `on-chain ✓  block ${height} · ${status}`, hash);
                    L(`verify: ✓ found in block ${height}, status ${status}, hash ${hash}`);
                    return { found: true, status, blockHeight: height, hash };
                }
                onStatus('fail', `on-chain but ${status}`, hash);
                L(`verify: found but status ${status}`);
                return { found: true, status, blockHeight: height, hash };
            }
        } catch (e) {
            L(`verify: scan attempt ${i + 1} error: ${e?.message || e}`);
        }
        await sleep(delayMs);
    }
    onStatus('fail', 'not found (scan timed out)');
    L('verify: not found within scan window');
    return { found: false };
}

// --- Vault presence check ---------------------------------------------------
// Look up whether a contract is deployed at `address` by asking the indexer for
// its latest contractAction. Non-null = the vault exists on this network.
// onStatus(kind, text): 'scanning' | 'ok' (exists) | 'fail' (not found / error).
const CHECK_VAULT_QUERY = `query CheckVault($address: HexEncoded!) {
  contractAction(address: $address) {
    __typename
    ... on ContractDeploy { transaction { hash block { height } } }
    ... on ContractCall { transaction { hash block { height } } }
    ... on ContractUpdate { transaction { hash block { height } } }
  }
}`;

export async function checkVaultExists(address, opts = {}, log = console.log, onStatus = () => {}) {
    const L = mklog(log);
    const addr = String(address || '').trim().replace(/^0x/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(addr)) { onStatus('fail', 'enter a 64-hex contract address'); return { exists: false }; }
    const url = opts.indexerUrl || _lastIndexerUri || PREVIEW_INDEXER_HTTP;
    onStatus('scanning', 'checking chain…');
    L(`check: looking up contract ${addr.slice(0, 16)}… via ${url}`);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: CHECK_VAULT_QUERY, variables: { address: addr } })
        });
        const json = await res.json();
        const action = json?.data?.contractAction;
        if (action) {
            const kind = action.__typename || 'contract';
            const height = action?.transaction?.block?.height;
            onStatus('ok', `vault exists on-chain ✓ (${kind}${height ? `, latest block ${height}` : ''})`);
            L(`check: ✓ contract present (${kind})`);
            return { exists: true, kind, blockHeight: height };
        }
        onStatus('fail', 'not deployed on this network — deploy one');
        L('check: contract not found');
        return { exists: false };
    } catch (e) {
        onStatus('fail', 'check error: ' + (e?.message || e));
        L(`check: error ${e?.message || e}`);
        return { exists: false, error: String(e?.message || e) };
    }
}
