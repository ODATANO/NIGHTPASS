/**
 * The remote lane: a local `@odatano/nightgate-tx` builder proves and signs
 * with a seed that never leaves this process, the hosted NIGHTGATE pays the
 * dust and submits (`sponsorUnboundTransaction` under an agent grant). No
 * wallet session, no worker, no sync. Verification reads go through the same
 * client, token-authenticated.
 */
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { blake2b256Hex, effectiveNetwork } from './passport-anchor';
import { buildMembershipSet } from './membership-set';
import { claimValidUntil } from './proof-plan';
import {
    ProofCartError,
    type AnchorTxInput, type ChainLane, type ClaimVerifyInput, type LaneTx, type ProofCartInput, type ProofCartOutcome,
    type CartClaimArgs
} from './chain-lane';

/** Reserved UUID: "use the sponsor pool" (the field is Edm.Guid). */
export const SPONSOR_POOL_SENTINEL = '00000000-0000-0000-0000-706f6f6c0000';

export interface RemoteLaneConfig {
    apiUrl: string;
    agentToken: string;
    networkId: string;
    indexerHttpUrl: string;
    indexerWsUrl: string;
    nodeUrl: string;
    cacheDir?: string;
    /** Our own proof server; when set, proving runs there instead of in-process wasm. */
    proofServerUrl?: string;
    ttlMinutes?: number;
}

/** Circuits the demo lane proves; prover keys are fetched for these only. */
export const REMOTE_LANE_CIRCUITS = ['attest', 'bindDocument', 'anchorContentRoot', 'proveFieldPredicate', 'proveFieldMembership'];

/**
 * Lane config from the environment. Throws with the missing key named, so a
 * half-configured container fails at the first chain call, not silently.
 */
export function remoteLaneConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteLaneConfig {
    const need = (k: string) => {
        const v = String(env[k] ?? '').trim();
        if (!v) throw new Error(`remote chain lane: ${k} is not set`);
        return v;
    };
    const indexerHttpUrl = need('NIGHTGATE_INDEXER_HTTP_URL');
    const indexerWsUrl = String(env.NIGHTGATE_INDEXER_WS_URL ?? '').trim() || deriveIndexerWsUrl(indexerHttpUrl);
    return {
        apiUrl: need('NIGHTGATE_API_URL').replace(/\/$/, ''),
        agentToken: need('DEMO_NIGHTGATE_AGENT_TOKEN'),
        networkId: String(env.NIGHTGATE_NETWORK ?? '').trim() || effectiveNetwork(),
        indexerHttpUrl,
        indexerWsUrl,
        nodeUrl: need('NIGHTGATE_NODE_URL'),
        cacheDir: String(env.NIGHTGATE_ZK_CACHE_DIR ?? '').trim() || join(homedir(), '.cache', 'nightgate-txbuilder', 'attestation-vault'),
        proofServerUrl: String(env.NIGHTGATE_PROOF_SERVER_URL ?? '').trim() || undefined,
        ttlMinutes: Number(env.NIGHTGATE_TX_TTL_MINUTES ?? 0) || undefined
    };
}

/** Same rule NIGHTGATE applies: http -> ws, `/ws` suffix on the versioned path. */
export function deriveIndexerWsUrl(httpUrl: string): string {
    return httpUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
}

// --- signer registry ---------------------------------------------------------
// A remote handle is a UUID (the producer actions type `sessionId` as UUID)
// that names a seed this process holds for the lifetime of one run. A
// registered handle selects the remote lane; NIGHTGATE session ids are never
// registered here. In memory only; the demo stores the seed encrypted.

const signers = new Map<string, { seedHex: string; contractAddress?: string }>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Register the seed of a run; `contractAddress` pins the vault every chain call of that run targets. */
export function registerRemoteSigner(handle: string, seedHex: string, opts: { contractAddress?: string } = {}): void {
    if (!UUID_RE.test(handle)) throw new Error(`remote signer handle must be a UUID (got '${handle}')`);
    if (!/^[0-9a-fA-F]{128}$/.test(seedHex)) throw new Error('remote signer seedHex must be 128 hex chars (64-byte BIP39 seed)');
    if (opts.contractAddress !== undefined && !/^[0-9a-fA-F]{64}$/.test(opts.contractAddress)) {
        throw new Error('remote signer contractAddress must be 64 hex chars');
    }
    signers.set(handle, { seedHex: seedHex.toLowerCase(), contractAddress: opts.contractAddress?.toLowerCase() });
}

export function releaseRemoteSigner(handle: string): void {
    signers.delete(handle);
}

export function hasRemoteSigner(handle: string): boolean {
    return signers.has(handle);
}

/** The vault leased to a registered run, if any. */
export function remoteVaultFor(handle: string | null | undefined): string | undefined {
    return handle ? signers.get(handle)?.contractAddress : undefined;
}

// --- transaction hash resolution ---------------------------------------------

const HASH64 = /^[0-9a-f]{64}$/i;

/**
 * A sponsored job reports the wallet SDK's transaction IDENTIFIER (66 hex,
 * `00`-prefixed), not the block-level hash the explorer and the rest of this
 * app use. The indexer maps one to the other (`transactions(offset:
 * {identifier})`); a few seconds may pass between chain finality and the
 * indexer having the block, hence the bounded retry. Falls back to the
 * identifier itself, so a lookup outage never loses the reference.
 */
export async function resolveTxHash(
    identifier: string,
    indexerHttpUrl: string,
    o: { fetchFn?: typeof fetch; attempts?: number; delayMs?: number } = {}
): Promise<string> {
    const id = String(identifier ?? '').replace(/^0x/, '');
    if (HASH64.test(id)) return id.toLowerCase();
    const fetchFn = o.fetchFn ?? fetch;
    const attempts = o.attempts ?? 6;
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, o.delayMs ?? 5000));
        try {
            const res = await fetchFn(indexerHttpUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: 'query($i:HexEncoded!){transactions(offset:{identifier:$i}){hash}}',
                    variables: { i: id }
                }),
                signal: AbortSignal.timeout(20_000)
            });
            const json: any = await res.json();
            const hash = json?.data?.transactions?.[0]?.hash;
            if (typeof hash === 'string' && HASH64.test(hash)) return hash.toLowerCase();
        } catch { /* retry */ }
    }
    return id;
}

// --- prover-key cache ----------------------------------------------------------
// The txbuilder reuses any cached file as is, and the prover keys of one vault
// lineage prove nothing on the next (0.23 redeployed the vault). The cache is
// therefore keyed by the artifact digest the hosted manifest reports.

export interface ContractManifestLike {
    contracts?: { name?: string; artifactHash?: string }[];
}

/** The cache directory for the manifest's attestation-vault artifact; the base itself when the manifest names none. */
export function cacheDirForManifest(base: string, manifest: ContractManifestLike | null | undefined): string {
    const hash = manifest?.contracts?.find((c) => c?.name === 'attestation-vault')?.artifactHash;
    return typeof hash === 'string' && HASH64.test(hash) ? join(base, hash.slice(0, 16).toLowerCase()) : base;
}

const cacheDirPromises = new Map<string, Promise<string>>();

/**
 * Resolves the keyed cache directory once per process and API. Fail-closed:
 * without the manifest the lane does not build, because an unkeyed cache may
 * hold the keys of an earlier lineage (seen live 2026-09-08: a manifest
 * timeout under load led to "mismatched verifier keys" on the new vault).
 */
export function artifactCacheDir(
    cfg: RemoteLaneConfig, o: { fetchFn?: typeof fetch; attempts?: number; delayMs?: number } = {}
): Promise<string> {
    const base = cfg.cacheDir ?? join(homedir(), '.cache', 'nightgate-txbuilder', 'attestation-vault');
    const key = `${cfg.apiUrl}|${base}`;
    let p = cacheDirPromises.get(key);
    if (!p) {
        p = (async () => {
            const attempts = o.attempts ?? 4;
            let lastErr: unknown;
            for (let i = 0; i < attempts; i++) {
                if (i > 0) await new Promise((r) => setTimeout(r, o.delayMs ?? 5000));
                try {
                    const res = await (o.fetchFn ?? fetch)(`${cfg.apiUrl}/contract-manifest`, { signal: AbortSignal.timeout(30_000) });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const dir = cacheDirForManifest(base, await res.json() as ContractManifestLike);
                    if (dir === base) throw new Error('manifest names no attestation-vault artifact');
                    return dir;
                } catch (e) {
                    lastErr = e;
                }
            }
            cacheDirPromises.delete(key);
            throw new Error(`remote chain lane: contract manifest unavailable after ${attempts} attempts (${String((lastErr as Error)?.message ?? lastErr)})`, { cause: lastErr });
        })();
        cacheDirPromises.set(key, p);
    }
    return p;
}

// --- retry classification -----------------------------------------------------

/**
 * Errors worth a REBUILD (fresh bytes, new idempotency key): the node's
 * pre-mempool state conflict (1010/104, fee unspent), a lost dust race the
 * sponsor did not absorb (1010/170, 1010/196), the pool reject (1014), and
 * the hosted API asking for a moment (503 JOB_ADMISSION_BUSY / WALLET_SYNCING,
 * 429) and a gateway answer that never reached a handler (502). Everything
 * else is final. Resubmitting identical bytes is never done.
 */
export function isRebuildable(err: unknown): boolean {
    const e = err as any;
    const status = Number(e?.status ?? 0);
    const code = String(e?.code ?? e?.job?.errorCode ?? '');
    const msg = String(e?.message ?? e?.job?.errorMessage ?? e ?? '');
    if (status === 429 || status === 502 || status === 503) return true;
    // The asset fetch inside createTxBuilder reports a gateway answer only in
    // its message (`ensureZkAssets: GET ... -> HTTP 502`).
    if (/->\s*HTTP (429|502|503)(?!\d)/.test(msg)) return true;
    if (/JOB_ADMISSION_BUSY|WALLET_SYNCING|WORKER_ROTATING|SPONSOR_POLICY_UNAVAILABLE/.test(code + ' ' + msg)) return true;
    return /\b1010\/(104|170|196)\b|\b1014\b|dust-race|DustDoubleSpend|InvalidDustSpendProof/i.test(msg);
}

// --- the lane ---------------------------------------------------------------

type Prepared = { circuitId: string; args: unknown[]; witnesses?: object; merkleProof?: object };

interface TxBuilderLike {
    attestationSecret: Uint8Array;
    attesterId: string;
    provingMode: 'wasm' | 'server';
    addresses: { night: string };
    buildSponsorable(input: {
        contractAddress: string; call?: Prepared; calls?: Prepared[]; bind: false;
        /** The calls past `orderedPrefix` share no state: grouped by execution stage before proving (0.4.2). */
        independentCalls?: boolean; orderedPrefix?: number;
    }): Promise<{ unboundTxB64: string; serializedBytes: number }>;
    close(): Promise<void>;
}

interface ClientLike {
    sponsorUnbound(p: Record<string, unknown>): Promise<Record<string, any> & { jobId: string; txHash?: string }>;
    verifyPredicate(p: Record<string, unknown>): Promise<any>;
    verifyAttestation(p: Record<string, unknown>): Promise<any>;
    getHealth(): Promise<any>;
}

let sdkPromise: Promise<{ txbuilder: any; calls: any; client: any; vault: any }> | null = null;
/** The ESM-only SDK, loaded once per process. */
function sdk() {
    sdkPromise ??= Promise.all([
        import('@odatano/nightgate-tx/txbuilder'),
        import('@odatano/nightgate-tx/calls'),
        import('@odatano/nightgate-tx/client'),
        import('@odatano/nightgate-tx/attestation-vault')
    ]).then(([txbuilder, calls, client, vault]) => ({ txbuilder, calls, client, vault }));
    return sdkPromise;
}

export class RemoteLane implements ChainLane {
    readonly kind = 'remote' as const;
    private builderPromise: Promise<TxBuilderLike> | null = null;
    private clientPromise: Promise<ClientLike> | null = null;
    private readonly log = cds.log('remote-lane');

    constructor(private readonly cfg: RemoteLaneConfig, private readonly seedHex: string, private readonly label = 'remote') {}

    /** Identity of the seed this lane signs with (attester id, night address). */
    identity(): Promise<{ attesterId: string; nightAddress: string; provingMode: string }> {
        return remoteIdentity(this.cfg, this.seedHex);
    }

    async attesterId(): Promise<string> {
        return (await this.identity()).attesterId;
    }

    private builder(): Promise<TxBuilderLike> {
        // A failed build (asset fetch, provider handshake) must not poison
        // the lane: the next attempt starts a fresh builder.
        this.builderPromise ??= (async () => {
            const [{ txbuilder, vault }, cacheDir] = await Promise.all([sdk(), artifactCacheDir(this.cfg)]);
            const t0 = Date.now();
            const b: TxBuilderLike = await txbuilder.createTxBuilder({
                seedHex: this.seedHex,
                networkId: this.cfg.networkId,
                indexerHttpUrl: this.cfg.indexerHttpUrl,
                indexerWsUrl: this.cfg.indexerWsUrl,
                nodeUrl: this.cfg.nodeUrl,
                zkConfigBaseUrl: `${this.cfg.apiUrl}/zk-config/attestation-vault`,
                contractClass: vault.Contract,
                contractName: 'attestation-vault',
                circuits: REMOTE_LANE_CIRCUITS,
                cacheDir,
                ...(this.cfg.proofServerUrl ? { provingMode: 'server', proofServerUrl: this.cfg.proofServerUrl } : {}),
                ...(this.cfg.ttlMinutes ? { ttlMinutes: this.cfg.ttlMinutes } : {}),
                // Vault circuits move no value: nothing to balance, so no
                // wallet sync (0.4.1). A value-moving call would fail at balancing.
                walletSync: false,
                onProgress: (e: Record<string, unknown>) => {
                    if (e?.phase === 'fetch') this.log.info(`[${this.label}] zk asset ${String(e.file ?? e.circuit ?? '')}`);
                }
            });
            this.log.info(`[${this.label}] txbuilder ready in ${Date.now() - t0}ms (proving ${b.provingMode}, attester ${b.attesterId.slice(0, 12)}...)`);
            return b;
        })().catch((e) => {
            this.builderPromise = null;
            throw e;
        });
        return this.builderPromise;
    }

    private client(): Promise<ClientLike> {
        this.clientPromise ??= sdk().then(({ client }) => client.connect({
            baseUrl: this.cfg.apiUrl, agentToken: this.cfg.agentToken, timeoutMs: 180_000, pollMs: 4000
        }) as ClientLike);
        return this.clientPromise;
    }

    /** Build locally, hand the unbound bytes to the sponsor, wait for the chain. Rebuilds on the retryable classes. */
    private async buildAndSponsor(
        label: string, contractAddress: string, prepare: () => Promise<Prepared[]>,
        batch: { independentCalls?: boolean; orderedPrefix?: number } = {}
    ): Promise<LaneTx> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 15_000));
            try {
                const [b, ng] = await Promise.all([this.builder(), this.client()]);
                const calls = await prepare();
                const t0 = Date.now();
                const built = calls.length === 1
                    ? await b.buildSponsorable({ contractAddress, call: calls[0], bind: false })
                    : await b.buildSponsorable({ contractAddress, calls, bind: false, ...batch });
                this.log.info(`[${this.label}] ${label}: built ${built.serializedBytes}B in ${Date.now() - t0}ms, handing to sponsor`);
                const job = await ng.sponsorUnbound({
                    unboundTxB64: built.unboundTxB64,
                    sponsorSessionId: SPONSOR_POOL_SENTINEL,
                    idempotencyKey: randomUUID()
                });
                const txId = String(job?.txHash ?? '');
                if (!txId) throw new Error(`${label}: sponsor job ${job?.jobId ?? '?'} succeeded without a transaction hash`);
                const txHash = await resolveTxHash(txId, this.cfg.indexerHttpUrl);
                if (txHash === txId.replace(/^0x/, '') && !HASH64.test(txId)) {
                    this.log.warn(`[${this.label}] ${label}: could not resolve identifier ${txId.slice(0, 12)}... to a block hash; keeping the identifier`);
                }
                this.log.info(`[${this.label}] ${label}: landed ${txHash} (job ${String(job.jobId ?? '').slice(0, 8)}, id ${txId.slice(0, 12)}...)`);
                return { txHash, jobId: String(job.jobId ?? '') };
            } catch (e) {
                lastErr = e;
                if (!isRebuildable(e) || attempt === 2) break;
                this.log.warn(`[${this.label}] ${label}: retryable (${String((e as Error)?.message ?? e).slice(0, 80)}), rebuilding...`);
            }
        }
        throw new Error(`${label}: ${String((lastErr as Error)?.message ?? lastErr)}`, { cause: lastErr });
    }

    /**
     * One transaction of the anchor plan (lineage 4: the whole anchor). The
     * record is keyed by this lane's own attester id, so no other caller can
     * collide with it; a failure here is final for the caller to judge.
     */
    submitAnchorTx({ contractAddress, tx }: AnchorTxInput): Promise<LaneTx> {
        return this.buildAndSponsor(tx.label, contractAddress, async () => {
            const [{ calls: c }, b] = await Promise.all([sdk(), this.builder()]);
            const secret = b.attestationSecret;
            return tx.calls.map((call): Prepared => {
                switch (call.circuit) {
                    case 'attest':
                        return c.prepareAttest({ payloadHash: call.args[0], metadataHash: call.args[1], attestationSecret: secret });
                    case 'bindDocument':
                        return c.prepareBindDocument({ documentId: call.args[0], payloadHash: call.args[1], attestationSecret: secret });
                    case 'anchorContentRoot':
                        return c.prepareAnchorContentRoot({
                            payloadHash: call.args[0], contentRoot: call.args[1], schemaId: call.args[2], attestationSecret: secret
                        });
                    default:
                        throw new Error(`remote lane: unsupported anchor circuit '${String((call as any).circuit)}'`);
                }
            });
        });
    }

    async submitProofCart(input: ProofCartInput): Promise<ProofCartOutcome> {
        let landedTx = '';
        try {
            const out = await this.buildAndSponsor('proof cart', input.contractAddress, async () => {
                const [{ calls: c, vault }, b] = await Promise.all([sdk(), this.builder()]);
                const secret = b.attestationSecret;
                // The claims name the attester's RECORD, not the payload: a
                // cart on another attester's passport proves against that
                // record (the proof circuits check no attester secret).
                const attesterId = input.attesterId ?? b.attesterId;
                const recordKey: string = c.recordKeyOf({ pureCircuits: vault.pureCircuits, attesterId, payloadHash: input.payloadHash });
                const validUntil = input.validUntil ?? claimValidUntil();
                const calls: Prepared[] = [];
                if (input.contentRoot) {
                    calls.push(c.prepareAnchorContentRoot({
                        payloadHash: input.payloadHash, contentRoot: input.contentRoot, schemaId: input.schemaId, attestationSecret: secret
                    }));
                }
                for (const claim of input.claims) calls.push(await this.prepareClaim(c, secret, recordKey, validUntil, claim));
                return calls;
            }, {
                // Claims write distinct keys: the builder may group them by
                // execution stage. An in-batch root anchor stays first.
                independentCalls: true, orderedPrefix: input.contentRoot ? 1 : 0
            });
            landedTx = out.txHash;
            // The hosted lane issues no predicate-attestation ids; claims are
            // verified by their on-chain coordinates (verifyClaimLanded).
            return { ...out, claimIds: new Map() };
        } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            const job = (e as any)?.cause?.job ?? (e as any)?.job;
            const partial = /OnChainStatus|PARTIAL/i.test(msg + ' ' + String(job?.errorCode ?? '')) || !!landedTx;
            throw new ProofCartError(msg, { partial, jobId: String(job?.jobId ?? ''), cause: e });
        }
    }

    private async prepareClaim(c: any, secret: Uint8Array, recordKey: string, validUntil: number, claim: CartClaimArgs): Promise<Prepared> {
        if (claim.predicate === 'setMembership') {
            const set = await buildMembershipSet(claim.allowedValues);
            const path = set.proofFor(claim.value);
            if (!path) throw new Error(`remote lane: '${claim.value}' is not in the allow-list`);
            return c.prepareProveFieldMembership({
                recordKey, validUntil, fieldKey: claim.fieldKey, setRoot: set.setRoot,
                merkleProof: {
                    fieldDigest: blake2b256Hex(claim.value), fieldSalt: claim.salt,
                    siblings: claim.siblings, dirs: claim.dirs,
                    setProof: { siblings: path.setSiblings, dirs: path.setDirs }
                },
                attestationSecret: secret
            });
        }
        return c.prepareProveFieldPredicate({
            recordKey, validUntil, fieldKey: claim.fieldKey, threshold: claim.threshold,
            op: claim.predicate === 'greaterOrEqual' ? 1 : 0,
            merkleProof: { fieldValue: claim.value, fieldSalt: claim.salt, siblings: claim.siblings, dirs: claim.dirs },
            attestationSecret: secret
        });
    }

    async verifyClaimLanded(input: ClaimVerifyInput): Promise<{ verified: boolean; txHash: string }> {
        const ng = await this.client();
        const membership = input.predicate === 'setMembership';
        if (membership && !input.setRoot) return { verified: false, txHash: '' };
        const attesterId = input.attesterId ?? await this.attesterId();
        const res = await ng.verifyPredicate({
            contractAddress: input.contractAddress, attesterId, payloadHash: input.payloadHash, fieldKey: input.fieldKey,
            predicate: input.predicate,
            ...(membership ? { setRoot: input.setRoot } : { threshold: Number(input.threshold ?? 0) }),
            compiledArtifactRef: 'attestation-vault'
        });
        return { verified: res?.verified === true, txHash: '' };
    }

    /** Anchor effect check through the hosted API (token-authenticated); the record defaults to this lane's own. */
    async verifyAnchor(p: { contractAddress: string; payloadHash: string; attesterId?: string; contentRoot?: string; schemaId?: string }): Promise<boolean> {
        const ng = await this.client();
        const attesterId = p.attesterId ?? await this.attesterId();
        const res = await ng.verifyAttestation({
            contractAddress: p.contractAddress, attesterId, payloadHash: p.payloadHash,
            ...(p.contentRoot ? { contentRoot: p.contentRoot, schemaId: p.schemaId } : {}),
            compiledArtifactRef: 'attestation-vault'
        });
        return res?.verified === true && (!p.contentRoot || res?.contentRootOk === true);
    }

    async dispose(): Promise<void> {
        const b = this.builderPromise;
        this.builderPromise = null;
        if (b) await (await b).close().catch(() => { /* already closed */ });
    }
}

interface VerifyClientLike {
    callFunction(name: string, params?: Record<string, unknown>): Promise<any>;
    getHealth(): Promise<any>;
}
let hostedClientPromise: Promise<VerifyClientLike> | null = null;
let hostedClientKey = '';
/** A token-authenticated client for the read surface, shared per process. */
export function hostedVerifyClient(cfg: RemoteLaneConfig): Promise<VerifyClientLike> {
    const key = `${cfg.apiUrl}|${cfg.agentToken}`;
    if (!hostedClientPromise || hostedClientKey !== key) {
        hostedClientKey = key;
        hostedClientPromise = sdk().then(({ client }) => client.connect({
            baseUrl: cfg.apiUrl, agentToken: cfg.agentToken, timeoutMs: 120_000
        }) as VerifyClientLike);
    }
    return hostedClientPromise;
}

/**
 * Fetch the prover keys once ahead of the first run (idempotent, cached on
 * disk), so a visitor never waits for the download inside their timeline.
 */
export async function ensureRemoteZkAssets(cfg: RemoteLaneConfig = remoteLaneConfigFromEnv()): Promise<{ fetched: number; cached: number }> {
    const [{ txbuilder }, cacheDir] = await Promise.all([sdk(), artifactCacheDir(cfg)]);
    const r = await txbuilder.ensureZkAssets({
        zkConfigBaseUrl: `${cfg.apiUrl}/zk-config/attestation-vault`,
        cacheDir,
        circuits: REMOTE_LANE_CIRCUITS
    });
    return { fetched: Number(r?.fetched ?? 0), cached: Number(r?.cached ?? 0) };
}

/**
 * Attester id and NIGHT address of a seed, derived without a builder or the
 * network (nightgate-tx 0.4.1 `deriveIdentity`).
 */
export async function remoteIdentity(cfg: RemoteLaneConfig, seedHex: string): Promise<{ attesterId: string; nightAddress: string; provingMode: string }> {
    const { txbuilder } = await sdk();
    const id = await txbuilder.deriveIdentity({ seedHex, networkId: cfg.networkId });
    return { attesterId: id.attesterId, nightAddress: id.addresses.night, provingMode: cfg.proofServerUrl ? 'server' : 'wasm' };
}

/** The lane for a registered remote handle, configured from the environment. */
export function remoteLaneFor(handle: string, cfg: RemoteLaneConfig = remoteLaneConfigFromEnv()): RemoteChainLane {
    const signer = signers.get(handle);
    if (!signer) throw new Error(`remote chain lane: no signer registered for '${handle}'`);
    return createRemoteLane(cfg, signer.seedHex, handle.slice(0, 8));
}

// --- worker host --------------------------------------------------------------
// A build (wallet facade start, ledger assembly, the proving client) is
// CPU-bound wasm on whichever thread runs it; on the CAP thread it stalls
// every request for the length of the build. Each lane therefore lives in its
// own worker thread behind a proxy with the same surface.

/** The remote lane's surface beyond ChainLane. */
export interface RemoteChainLane extends ChainLane {
    identity(): Promise<{ attesterId: string; nightAddress: string; provingMode: string }>;
    attesterId(): Promise<string>;
    verifyAnchor(p: { contractAddress: string; payloadHash: string; attesterId?: string; contentRoot?: string; schemaId?: string }): Promise<boolean>;
}

/** Methods the worker host forwards to its RemoteLane. */
export const REMOTE_LANE_WORKER_METHODS: ReadonlySet<string> = new Set([
    'identity', 'attesterId', 'submitAnchorTx', 'submitProofCart', 'verifyClaimLanded', 'verifyAnchor', 'dispose'
]);

const WORKER_FILE = __filename.replace(/lane-remote(\.[cm]?[jt]s)$/, 'lane-remote-worker$1');

/** An error as it crosses the thread boundary. */
export interface LaneErrorShape {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    status?: number;
    partial?: boolean;
    jobId?: string;
    claimIds?: [string, string][];
}

export function serializeLaneError(e: unknown): LaneErrorShape {
    const err = e as any;
    const out: LaneErrorShape = {
        name: String(err?.name ?? 'Error'),
        message: String(err?.message ?? err ?? 'unknown error')
    };
    if (typeof err?.stack === 'string') out.stack = err.stack;
    const code = err?.code ?? err?.cause?.job?.errorCode ?? err?.cause?.code;
    if (code !== undefined) out.code = String(code);
    const status = Number(err?.status ?? err?.cause?.status ?? 0);
    if (status) out.status = status;
    if (err instanceof ProofCartError) {
        out.partial = err.partial;
        out.jobId = err.jobId;
        out.claimIds = [...err.claimIds.entries()];
    }
    return out;
}

export function deserializeLaneError(o: LaneErrorShape): Error {
    const err: Error & { code?: string; status?: number } = o.name === 'ProofCartError'
        ? new ProofCartError(o.message, { partial: !!o.partial, jobId: o.jobId, claimIds: new Map(o.claimIds ?? []) })
        : new Error(o.message);
    if (o.name !== 'ProofCartError' && o.name) err.name = o.name;
    if (o.stack) err.stack = o.stack;
    if (o.code !== undefined) err.code = o.code;
    if (o.status !== undefined) err.status = o.status;
    return err;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Main-thread proxy of a RemoteLane running in a worker thread. */
export class RemoteLaneWorker implements RemoteChainLane {
    readonly kind = 'remote' as const;
    private worker: Worker | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    private readonly log = cds.log('remote-lane');

    constructor(private readonly cfg: RemoteLaneConfig, private readonly seedHex: string, private readonly label = 'remote') {}

    private spawn(): Worker {
        if (this.worker) return this.worker;
        // Only tsx's CommonJS hook in the worker: the inherited ESM loader
        // cannot resolve this codebase's extensionless imports there.
        const w = new Worker(WORKER_FILE, {
            execArgv: ['--require', 'tsx/cjs'],
            workerData: { cfg: this.cfg, seedHex: this.seedHex, label: this.label }
        });
        w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: LaneErrorShape }) => {
            const p = this.pending.get(m.id);
            if (!p) return;
            this.pending.delete(m.id);
            if (m.ok) p.resolve(m.result);
            else p.reject(deserializeLaneError(m.error ?? { name: 'Error', message: 'worker returned no error' }));
        });
        w.on('error', (e) => this.failAll(new Error(`[${this.label}] lane worker crashed: ${String((e as Error)?.message ?? e)}`, { cause: e })));
        w.on('exit', (code) => {
            if (this.worker === w) this.worker = null;
            this.failAll(new Error(`[${this.label}] lane worker exited with code ${code}`));
        });
        this.worker = w;
        return w;
    }

    private failAll(err: Error): void {
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
    }

    private call<T>(method: string, ...args: unknown[]): Promise<T> {
        const w = this.spawn();
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            w.postMessage({ id, method, args });
        });
    }

    /** Liveness of the worker thread; spawns it when needed. */
    ping(): Promise<{ threadId: number; label: string }> {
        return this.call('ping');
    }

    identity(): Promise<{ attesterId: string; nightAddress: string; provingMode: string }> {
        return this.call('identity');
    }

    attesterId(): Promise<string> {
        return this.call('attesterId');
    }

    submitAnchorTx(input: AnchorTxInput): Promise<LaneTx> {
        return this.call('submitAnchorTx', input);
    }

    async submitProofCart(input: ProofCartInput): Promise<ProofCartOutcome> {
        const out = await this.call<ProofCartOutcome>('submitProofCart', input);
        return { ...out, claimIds: out.claimIds instanceof Map ? out.claimIds : new Map(out.claimIds ?? []) };
    }

    verifyClaimLanded(input: ClaimVerifyInput): Promise<{ verified: boolean; txHash: string }> {
        return this.call('verifyClaimLanded', input);
    }

    verifyAnchor(p: { contractAddress: string; payloadHash: string; attesterId?: string; contentRoot?: string; schemaId?: string }): Promise<boolean> {
        return this.call('verifyAnchor', p);
    }

    /** Releases the lane in the worker, then the thread. Idempotent. */
    async dispose(): Promise<void> {
        const w = this.worker;
        if (!w) return;
        try {
            await this.call('dispose');
        } catch (e) {
            this.log.warn(`[${this.label}] lane dispose in worker failed: ${String((e as Error)?.message ?? e)}`);
        }
        this.worker = null;
        await w.terminate().catch(() => { /* already gone */ });
    }
}

/**
 * A remote lane for one seed: in a worker thread by default, in-process when
 * `NIGHTPASS_REMOTE_LANE_INLINE` is set (tests, single-threaded debugging).
 */
export function createRemoteLane(cfg: RemoteLaneConfig, seedHex: string, label = 'remote', env: NodeJS.ProcessEnv = process.env): RemoteChainLane {
    const inline = /^(1|true|yes|on)$/i.test(String(env.NIGHTPASS_REMOTE_LANE_INLINE ?? '').trim());
    return inline ? new RemoteLane(cfg, seedHex, label) : new RemoteLaneWorker(cfg, seedHex, label);
}
