// NIGHTPASS wallet-connector flow (Lace). Bundled to app/connector/lib by vite
// (npm run build:connector-lib); the producer cockpit dynamic-imports it in-app.
//
// Uses NIGHTGATE's browser export (@odatano/nightgate-tx/calls: connectContract
// with call, batch and deploy) + the DApp-Connector wallet (window.midnight, e.g. Lace)
// to attest / grant / revoke on the AttestationVault. This is the human-attester path. attest+grant+revoke
// all run with the SAME wallet-derived attester secret, so a full self-contained
// cycle works (a server-created grant uses a different secret and would fail the
// on-chain "not attester" assert; a known cross-path caveat).

// Node-global polyfills for the browser. Parts of the Midnight SDK (tx/zswap
// serialization in the submit path) use Node's `Buffer`, which Vite does not
// polyfill automatically. Provide it globally before any SDK code runs.
import { Buffer as NodeBuffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = NodeBuffer;
if (typeof globalThis.global === 'undefined') globalThis.global = globalThis;

// Shared anchor call plan (pure TS, bundled by vite): the SAME ordered circuit
// list the server submits, so the two anchor paths cannot drift.
import { anchorTxPlan } from '../../srv/lib/anchor-plan';
import { prepareVaultCall } from '../../srv/lib/chain-lane';
import { proofCartPlan, claimKey, claimValidUntil } from '../../srv/lib/proof-plan';

// NOTE: all heavy SDK/WASM imports are LAZY (loaded inside the action functions)
// so the page + wallet connect work even before any ZK artifact loads. Importing
// the SDK eagerly would pull ledger/runtime WASM at page load
// and a failure there would leave the page blank with no connect button.
const loadBrowserSdk = () => import('@odatano/nightgate-tx/calls');
const loadVaultContract = () => import('@odatano/nightgate-tx/attestation-vault');

const CONTRACT = 'attestation-vault';

// Lace's getConfiguration() points the prover at the hosted
// https://proof-server.preprod.midnight.network, but that host omits the
// Access-Control-Allow-Origin header on the actual POST /prove response (only
// the preflight has it), so a browser fetch is blocked by CORS. A LOCAL proof
// server (docker midnightntwrk/proof-server, port 6300) does send ACAO on the
// real response, so we self-prove against it instead. Requires the local proof
// server to be running.
const LOCAL_PROVER_URL = 'http://localhost:6300';

// Lifetime of a built transaction.
const TX_TTL_MINUTES = 30;

/**
 * Opt-in switch for wallet-delegated proving (`proving: 'wallet'`).
 *
 * Set `localStorage['nightpass:wallet-prover'] = '1'` in the cockpit tab and contract circuits are
 * proved INSIDE the connected wallet; no docker proof server is needed at all. Off by default
 * because it trades seconds (docker prover) for MINUTES of the user's own CPU per circuit, which
 * is the wrong default for a demo. Reading localStorage is wrapped: it throws in some privacy
 * modes, and a wallet-proving toggle must never be able to break the normal path.
 */
function walletProvingRequested() {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('nightpass:wallet-prover') === '1';
    } catch {
        return false;
    }
}

// Network + indexer come from the SERVER at runtime (issue #2): the browser
// wallet must anchor to the same chain as the server worker, so the single
// source of truth is the server's effective NIGHTGATE config, exposed at
// /api/v1/passport/runtime-config. Falls back to preview when the endpoint is
// unreachable (e.g. static hosting without the CAP server).
let _runtimeConfig = null;
async function runtimeConfig() {
    if (_runtimeConfig) return _runtimeConfig;
    try {
        const r = await fetch('/api/v1/passport/runtime-config');
        if (r.ok) {
            const cfg = await r.json();
            if (cfg?.network) { _runtimeConfig = cfg; return _runtimeConfig; }
        }
    } catch { /* no server config reachable, use the fallback below */ }
    _runtimeConfig = {
        network: 'preprod',
        indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql'
    };
    return _runtimeConfig;
}
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
    const { network } = await runtimeConfig();
    return initial.connect(network); // v4 ConnectedAPI
}

// App-managed attester secret.
//
// The Midnight DApp Connector (Lace v4) does NOT implement message signing.
// `api.signData(...)` throws `Method not implemented.` So the attester identity
// cannot be derived from a wallet signature; the fallback is a consumer-owned
// secret. We generate a random 32-byte secret once,
// persist it in localStorage keyed by the connected wallet's shielded address,
// and reuse it for attest/grant/revoke so they share one attester identity.
//
// Cross-path caveat: this identity differs from the server's
// seed-HMAC identity, so a server-created grant can't be revoked here and vice
// versa. Run a full attest to grant to revoke cycle in-browser with the same wallet.
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
/**
 * The attester identity of this wallet's app-managed secret, 64 hex, as the
 * vault's caller_id(). Records are keyed by it, so the cockpit stores it next
 * to the anchor.
 */
export async function attesterIdOf(api) {
    const [{ computeAttesterId }, secret] = await Promise.all([loadBrowserSdk(), deriveAttesterSecret(api)]);
    return computeAttesterId(secret);
}

/**
 * The ledger key of an attester's record of a payload (`recordKeyOf` over the
 * vault's pure circuit). Defaults to this wallet's own attester id; pass the
 * passport's stamped attester to prove on another attester's record.
 */
export async function recordKeyFor(api, payloadHash, attesterId) {
    const [{ recordKeyOf }, vault] = await Promise.all([loadBrowserSdk(), loadVaultContract()]);
    const owner = attesterId || await attesterIdOf(api);
    return recordKeyOf({ pureCircuits: vault.pureCircuits, attesterId: owner, payloadHash });
}

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

/**
 * Connects the vault through the wallet. The wallet balances, pays and submits
 * every transaction. Without `contractAddress` the object can only deploy.
 */
async function connectVault(api, contractAddress, log) {
    _lastSubmittedTxId = null;
    log('connecting the vault (manifest, zk-config, wallet; the first call downloads ~10MB WASM)…');
    const [{ connectContract }, { Contract }, walletConfig] = await Promise.all([
        loadBrowserSdk(), loadVaultContract(), api.getConfiguration()
    ]);
    _lastIndexerUri = walletConfig?.indexerUri ?? _lastIndexerUri;
    const vault = await connectContract({
        connector: api,
        contract: CONTRACT,
        contractClass: Contract,
        manifestUrl: new URL('/contract-manifest', location.origin).href,
        ...(contractAddress ? { contractAddress } : {}),
        // 'wallet' throws on a wallet that cannot prove, so private inputs never reach a server unasked.
        proving: walletProvingRequested() ? 'wallet' : 'server',
        proofServerUrl: LOCAL_PROVER_URL,
        ttlMinutes: TX_TTL_MINUTES
    });
    log(`network id: ${vault.networkId}, indexer: ${walletConfig?.indexerUri ?? '(not reported)'}`);
    log(vault.provingModality === 'wallet'
        ? 'prover: WALLET-DELEGATED (in-wallet prover; expect minutes per circuit)'
        : `prover: ${LOCAL_PROVER_URL}`);
    return vault;
}

/** Runs one prepared call ({ circuitId, args, witnesses }) as one transaction. */
async function runCall(api, contractAddress, call, log) {
    if (!contractAddress) throw new Error('contractAddress is required (the deployed vault address)');
    const vault = await connectVault(api, contractAddress, log);
    log(`submitting ${call.circuitId} (prove + balance + submit via wallet)…`);
    const tx = await vault.call(call);
    _lastSubmittedTxId = tx.txHash;
    log(`submitted ${call.circuitId}: ${tx.txHash}`);
    return tx;
}

/**
 * Runs prepared calls on one vault as ONE transaction with one wallet approval.
 * They apply in array order unless `order.independentCalls` is set. A batch the
 * ledger would refuse fails before proving, with nothing submitted.
 */
async function runBatch(api, contractAddress, prepared, attestationSecret, log, order = {}) {
    if (!contractAddress) throw new Error('contractAddress is required (the deployed vault address)');
    const [{ prepareVaultBatch }, vault] = await Promise.all([loadBrowserSdk(), connectVault(api, contractAddress, log)]);
    const { calls, witnesses } = prepareVaultBatch(prepared, { attestationSecret });
    const label = calls.map((c) => c.circuitId).join('+');
    log(`submitting batch [${label}] (ONE prove + balance + submit via wallet)…`);
    const tx = await vault.batch(calls, { witnesses, ...order });
    _lastSubmittedTxId = tx.txHash;
    log(`submitted batch [${label}]: ${tx.txHash}`);
    return tx;
}

/**
 * Deploy a fresh AttestationVault from the connected (funded) wallet. Returns
 * the deployed contract address. Uses the SAME app-managed attester secret as
 * attest/grant/revoke so the deployer-bound attester identity matches: a vault
 * deployed here can be attested + disclosure-managed by this same wallet.
 */
export async function deployVault(api, log = console.log) {
    const L = mklog(log);
    L('deploy: loading browser SDK…');
    const { buildAttestationVaultWitnesses } = await loadBrowserSdk();
    L('deploy: deriving app-managed attester secret (binds the deployer identity)…');
    const attestationSecret = await deriveAttesterSecret(api);

    // Constructor: (registrar, recovery). The deployer's attester id becomes
    // the registrar. A zero recovery id disables the recovery modes, so a
    // lost registrar key locks the id registry for good.
    const registrarId = fromHex(await attesterIdOf(api));
    const recoveryId = new Uint8Array(32);
    const vault = await connectVault(api, undefined, L);
    L(`deploying attestation-vault (registrar ${toHex(registrarId).slice(0, 12)}…, no recovery; prove + balance + submit via wallet)…`);
    const tx = await vault.deploy({
        args: [registrarId, recoveryId],
        witnesses: buildAttestationVaultWitnesses({ attestationSecret })
    });
    _lastSubmittedTxId = tx.txHash;
    L(`deployed attestation-vault at: ${tx.contractAddress}`);
    return { contractAddress: tx.contractAddress, result: tx };
}

function mklog(log) {
    return (m) => { try { log(m); } catch {} console.log('[connector] ' + m); };
}

/** attest(payload_hash, metadata_hash) */
export async function attest(api, { contractAddress, payloadHash, metadataHash }, log = console.log) {
    const L = mklog(log);
    L('attest: loading browser SDK…');
    const { prepareAttest } = await loadBrowserSdk();
    L('attest: deriving app-managed attester secret (no wallet popup)…');
    const attestationSecret = await deriveAttesterSecret(api);
    return runCall(api, contractAddress, prepareAttest({ payloadHash, metadataHash, attestationSecret }), L);
}

/** grantDisclosure(payload_hash, grantee, level): level 0=public,1=legit,2=authority */
export async function grantDisclosure(api, { contractAddress, payloadHash, grantee, level }, log = console.log) {
    const L = mklog(log);
    L('grant: loading browser SDK…');
    const { prepareGrantDisclosure } = await loadBrowserSdk();
    L('grant: deriving app-managed attester secret (no wallet popup)…');
    const attestationSecret = await deriveAttesterSecret(api);
    return runCall(api, contractAddress, prepareGrantDisclosure({ payloadHash, grantee, level, attestationSecret }), L);
}

/** revokeDisclosure(payload_hash, grantee) */
export async function revokeDisclosure(api, { contractAddress, payloadHash, grantee }, log = console.log) {
    const L = mklog(log);
    L('revoke: loading browser SDK…');
    const { prepareRevokeDisclosure } = await loadBrowserSdk();
    L('revoke: deriving app-managed attester secret (no wallet popup)…');
    const attestationSecret = await deriveAttesterSecret(api);
    return runCall(api, contractAddress, prepareRevokeDisclosure({ payloadHash, grantee, attestationSecret }), L);
}

// --- Field-bound Predicate (value bound to a SPECIFIC passport field) --------
// Hardened flow that answers "is this the value from THIS passport?". The value
// is proven to be a leaf in a Merkle content-root anchored at attest time, so it
// can't be swapped for an arbitrary number:
//   1) anchorContentRoot(payload_hash, content_root): pins the root over the
//      passport's provable fields (done once, typically right after attest).
//   2) proveFieldPredicate(payload_hash, field_key, threshold, op): recomputes
//      the field's Merkle leaf from the witnessed value + inclusion path, asserts
//      it folds to the anchored root, THEN asserts the predicate. A successful tx
//      proves the predicate holds for THIS passport's field, value still hidden.

/**
 * anchorContentRoot(payload_hash, content_root, schema_id): pin the field
 * Merkle root plus the schema it was built over. The schema id is the depth-4
 * root over the 16 slot descriptors; the cross-root comparison circuit
 * recomputes it, so a root anchored under a foreign schema label cannot be
 * compared later. Anchoring is insert-once: re-anchoring the same payload with
 * a DIFFERENT root or schema is rejected in-circuit (an identical re-anchor is
 * a no-op).
 */
export async function anchorContentRoot(api, { contractAddress, payloadHash, contentRoot, schemaId }, log = console.log) {
    const L = mklog(log);
    if (!schemaId) throw new Error('anchorContentRoot: schemaId is required (the third circuit argument)');
    L('anchorContentRoot: loading browser SDK…');
    const { prepareAnchorContentRoot } = await loadBrowserSdk();
    L('anchorContentRoot: deriving app-managed attester secret…');
    const attestationSecret = await deriveAttesterSecret(api);
    L('anchoring content root (binds the passport fields for later field-bound proofs)…');
    return runCall(api, contractAddress, prepareAnchorContentRoot({ payloadHash, contentRoot, schemaId, attestationSecret }), L);
}

/**
 * Anchor a passport in ONE transaction: attest + optional anchorContentRoot +
 * bindDocument against the same vault, one wallet approval. The call list
 * comes from the shared anchorTxPlan (the same source as the server lanes).
 * bindDocument binds the passportIdHash to this wallet's record and asserts
 * the attest, so the calls apply in plan order. Returns the submit result
 * plus the attester id the record is keyed by.
 */
export async function anchorBatch(api, { contractAddress, payloadHash, metadataHash, passportIdHash, contentRoot, schemaId }, log = console.log) {
    const L = mklog(log);
    L('anchorBatch: loading browser SDK…');
    const sdk = await loadBrowserSdk();
    L('anchorBatch: deriving app-managed attester secret (no wallet popup)…');
    const attestationSecret = await deriveAttesterSecret(api);
    const attesterId = await sdk.computeAttesterId(attestationSecret);
    const txs = anchorTxPlan({ payloadHash, metadataHash, passportIdHash, ...(contentRoot ? { contentRoot, schemaId } : {}) });
    let last = null;
    for (let i = 0; i < txs.length; i++) {
        const prepared = txs[i].calls.map((c) => prepareVaultCall(sdk, attestationSecret, c));
        L(`anchorBatch: transaction ${i + 1}/${txs.length} [${txs[i].label}], please approve in your wallet`);
        last = await runBatch(api, contractAddress, prepared, attestationSecret, L);
    }
    return { ...last, attesterId };
}

/**
 * proveFieldPredicate(record_key, field_key, threshold, op, valid_until):
 * field-bound proof on the record `recordKey(attesterId, payloadHash)`.
 * `attesterId` defaults to this wallet's own; pass the passport's stamped
 * attester to prove on a record another wallet anchored (the proof circuits
 * check no attester secret). The inclusion material is { fieldValue (scaled
 * decimal string), fieldSalt (64-hex), siblings (4 × 64-hex), dirs (4
 * booleans) }; op 0 = value ≤ threshold, 1 = value ≥ threshold. `validUntil`
 * (UNIX seconds) defaults to the vault cap less a day. Returns the submit
 * result plus the `validUntil` the claim carries.
 */
export async function proveFieldPredicate(api, { contractAddress, payloadHash, attesterId, validUntil, fieldKey, threshold, op, fieldValue, fieldSalt, siblings, dirs }, log = console.log) {
    const L = mklog(log);
    if (!fieldSalt) throw new Error('proveFieldPredicate: fieldSalt is required (salted leaves)');
    L('proveFieldPredicate: loading browser SDK…');
    const { prepareProveFieldPredicate } = await loadBrowserSdk();
    L('proveFieldPredicate: deriving app-managed attester secret…');
    const attestationSecret = await deriveAttesterSecret(api);
    const recordKey = await recordKeyFor(api, payloadHash, attesterId);
    const until = Number(validUntil || claimValidUntil());
    const opNum = Number(op);
    const call = prepareProveFieldPredicate({
        recordKey, fieldKey, threshold: BigInt(threshold), op: opNum, validUntil: until,
        merkleProof: { fieldValue: String(fieldValue), fieldSalt, siblings, dirs },
        attestationSecret
    });
    L(`proving field ${fieldValue} ${opNum === 0 ? '≤' : '≥'} ${threshold}, bound to this passport's content root, value hidden…`);
    const tx = await runCall(api, contractAddress, call, L);
    L(`✓ field-bound predicate proven on-chain: the passport's own value ${opNum === 0 ? '≤' : '≥'} ${threshold} holds.`);
    return { ...tx, validUntil: until };
}

/**
 * Proof cart: prove N field-bound claims for ONE passport in ONE transaction
 * (one wallet approval, one fee). Two entry kinds may mix freely:
 *   - predicate: { fieldKey, threshold (scaled), op } plus the inclusion
 *     proof { fieldValue (scaled decimal string), siblings (4 x 64-hex),
 *     dirs (4 booleans) };
 *   - membership: { kind: 'membership', fieldKey, setRoot } plus
 *     { fieldDigest (64-hex), siblings (4), dirs (4), setSiblings (6 x
 *     64-hex), setDirs (6 booleans) } (proveFieldMembership: the hidden
 *     value's digest folds into BOTH the content root and the allow-list
 *     set root).
 * The claim list is validated/deduped by the shared proofCartPlan (same
 * source the server lane consumes).
 *
 * Each claim carries its own Merkle material. The SDK's prepareVaultBatch
 * puts it behind the one witnesses object a transaction takes.
 *
 * Failure semantics: a claim that does not hold rejects during LOCAL
 * proving ("predicate false" / non-member), so the whole cart aborts with
 * nothing submitted. Proving time stays additive (N proofs = N proving
 * runs); the cart amortizes approvals, balancing, fees and confirmations.
 */
export async function proveFieldPredicateBatch(api, { contractAddress, payloadHash, attesterId, validUntil, proofs }, log = console.log) {
    const L = mklog(log);
    if (!Array.isArray(proofs) || !proofs.length) throw new Error('proveFieldPredicateBatch: proofs must be a non-empty array');
    L('proveFieldPredicateBatch: loading browser SDK…');
    const { prepareProveFieldPredicate, prepareProveFieldMembership } = await loadBrowserSdk();
    L('proveFieldPredicateBatch: deriving app-managed attester secret…');
    const attestationSecret = await deriveAttesterSecret(api);
    // The claims name the RECORD (attester + payload); the passport's stamped
    // attester wins over this wallet's own, so a cart on a record another
    // wallet anchored proves against the right key.
    const recordKey = await recordKeyFor(api, payloadHash, attesterId);
    const planClaimOf = (p) => (p.kind === 'membership'
        ? { kind: 'membership', fieldKey: p.fieldKey, setRoot: p.setRoot }
        : { fieldKey: p.fieldKey, threshold: p.threshold, op: Number(p.op) });
    const plan = proofCartPlan({ recordKey, claims: proofs.map(planClaimOf), ...(validUntil ? { validUntil: Number(validUntil) } : {}) });
    if (plan.dropped.length) L(`proveFieldPredicateBatch: dropped ${plan.dropped.length} duplicate claim(s) (already in the cart)`);
    // Claims were deduped by their canonical claim key, so matching the
    // original proofs entry by the same key is unambiguous. The helpers
    // refuse a claim without its salt, digest or full-depth paths.
    const byKey = new Map(proofs.map((p) => [claimKey(planClaimOf(p)), p]));
    const prepared = plan.claims.map((c) => {
        const src = byKey.get(claimKey(c));
        if (!src) throw new Error(`no inclusion proof supplied for claim on field key ${c.fieldKey.slice(0, 16)}…`);
        const base = { recordKey, fieldKey: c.fieldKey, validUntil: plan.validUntil, attestationSecret };
        const path = { fieldSalt: src.fieldSalt, siblings: src.siblings, dirs: src.dirs };
        if (c.kind === 'membership') {
            return prepareProveFieldMembership({
                ...base, setRoot: c.setRoot,
                merkleProof: { ...path, fieldDigest: src.fieldDigest, setProof: { siblings: src.setSiblings, dirs: src.setDirs } }
            });
        }
        return prepareProveFieldPredicate({
            ...base, threshold: BigInt(c.threshold), op: c.op,
            merkleProof: { ...path, fieldValue: String(src.fieldValue) }
        });
    });
    L(`proveFieldPredicateBatch: ${prepared.length} proof(s) in one tx (proving runs once per claim, please wait)…`);
    // The claims write distinct keys, so the batch may group them by execution stage.
    const tx = await runBatch(api, contractAddress, prepared, attestationSecret, L, { independentCalls: true });
    L(`✓ ${prepared.length} field-bound claim(s) proven on-chain in one transaction, values hidden.`);
    return { ...tx, claims: plan.claims, dropped: plan.dropped, validUntil: plan.validUntil };
}

// --- On-chain verification (indexer scan) -----------------------------------
// The verification model is indexer-trust: a tx that landed in a block with
// status SUCCESS is confirmed. Polls the indexer (HTTP GraphQL) for the
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
    const url = opts.indexerUrl || _lastIndexerUri || (await runtimeConfig()).indexerHttpUrl;
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
    const url = opts.indexerUrl || _lastIndexerUri || (await runtimeConfig()).indexerHttpUrl;
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
        onStatus('fail', 'not deployed on this network; deploy one');
        L('check: contract not found');
        return { exists: false };
    } catch (e) {
        onStatus('fail', 'check error: ' + (e?.message || e));
        L(`check: error ${e?.message || e}`);
        return { exists: false, error: String(e?.message || e) };
    }
}
