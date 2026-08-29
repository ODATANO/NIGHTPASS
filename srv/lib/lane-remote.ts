/**
 * The remote lane: a local `@odatano/nightgate-tx` builder proves and signs
 * with a seed that never leaves this process, the hosted NIGHTGATE pays the
 * dust and submits (`sponsorUnboundTransaction` under an agent grant). No
 * wallet session, no worker, no sync. Verification reads go through the same
 * client, token-authenticated.
 */
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { blake2b256Hex, effectiveNetwork } from './passport-anchor';
import { buildMembershipSet } from './membership-set';
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
export const REMOTE_LANE_CIRCUITS = ['attest', 'bindPassport', 'anchorContentRoot', 'proveFieldPredicate', 'proveFieldMembership'];

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

// --- retry classification -----------------------------------------------------

/**
 * Errors worth a REBUILD (fresh bytes, new idempotency key): the node's
 * pre-mempool state conflict (1010/104, fee unspent), a lost dust race the
 * sponsor did not absorb (1010/170, 1010/196), the pool reject (1014), and
 * the hosted API asking for a moment (503 JOB_ADMISSION_BUSY / WALLET_SYNCING,
 * 429). Everything else is final. Resubmitting identical bytes is never done.
 */
export function isRebuildable(err: unknown): boolean {
    const e = err as any;
    const status = Number(e?.status ?? 0);
    const code = String(e?.code ?? e?.job?.errorCode ?? '');
    const msg = String(e?.message ?? e?.job?.errorMessage ?? e ?? '');
    if (status === 429 || status === 503) return true;
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
    buildSponsorable(input: { contractAddress: string; call?: Prepared; calls?: Prepared[]; bind: false }): Promise<{ unboundTxB64: string; serializedBytes: number }>;
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
    async identity(): Promise<{ attesterId: string; nightAddress: string; provingMode: string }> {
        const b = await this.builder();
        return { attesterId: b.attesterId, nightAddress: b.addresses.night, provingMode: b.provingMode };
    }

    private builder(): Promise<TxBuilderLike> {
        this.builderPromise ??= (async () => {
            const { txbuilder, vault } = await sdk();
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
                ...(this.cfg.cacheDir ? { cacheDir: this.cfg.cacheDir } : {}),
                ...(this.cfg.proofServerUrl ? { provingMode: 'server', proofServerUrl: this.cfg.proofServerUrl } : {}),
                ...(this.cfg.ttlMinutes ? { ttlMinutes: this.cfg.ttlMinutes } : {}),
                onProgress: (e: Record<string, unknown>) => {
                    if (e?.phase === 'fetch') this.log.info(`[${this.label}] zk asset ${String(e.file ?? e.circuit ?? '')}`);
                }
            });
            this.log.info(`[${this.label}] txbuilder ready in ${Date.now() - t0}ms (proving ${b.provingMode}, attester ${b.attesterId.slice(0, 12)}...)`);
            return b;
        })();
        return this.builderPromise;
    }

    private client(): Promise<ClientLike> {
        this.clientPromise ??= sdk().then(({ client }) => client.connect({
            baseUrl: this.cfg.apiUrl, agentToken: this.cfg.agentToken, timeoutMs: 180_000, pollMs: 4000
        }) as ClientLike);
        return this.clientPromise;
    }

    /** Build locally, hand the unbound bytes to the sponsor, wait for the chain. Rebuilds on the retryable classes. */
    private async buildAndSponsor(label: string, contractAddress: string, prepare: () => Promise<Prepared[]>): Promise<LaneTx> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 15_000));
            try {
                const [b, ng] = await Promise.all([this.builder(), this.client()]);
                const calls = await prepare();
                const t0 = Date.now();
                const built = calls.length === 1
                    ? await b.buildSponsorable({ contractAddress, call: calls[0], bind: false })
                    : await b.buildSponsorable({ contractAddress, calls, bind: false });
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

    async submitAnchorTx({ contractAddress, tx }: AnchorTxInput): Promise<LaneTx> {
        const single = tx.calls.length === 1 ? tx.calls[0] : null;
        // `attest` updates the vault's attestation-sequence cell, so two attests
        // in one block conflict and the loser lands as PARTIAL_SUCCESS (fee
        // spent, call not applied). attest is insert-once: when the state
        // read shows the hash is not attested, a rebuild cannot double-anchor.
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.submitAnchorTxOnce(contractAddress, tx);
            } catch (e) {
                const msg = String((e as Error)?.message ?? e);
                const collision = single?.circuit === 'attest' && attempt < 2
                    && /PARTIAL_SUCCESS|CHAIN_EXECUTION_FAILED|OnChainStatus/i.test(msg);
                if (!collision) throw e;
                const attested = await this.verifyAnchor({ contractAddress, payloadHash: single!.args[0] }).catch(() => false);
                if (attested) throw e;
                this.log.warn(`[${this.label}] attest lost a block collision (${msg.slice(0, 60)}); rebuilding`);
                await new Promise((r) => setTimeout(r, 10_000));
            }
        }
    }

    private submitAnchorTxOnce(contractAddress: string, tx: AnchorTxInput['tx']): Promise<LaneTx> {
        return this.buildAndSponsor(tx.label, contractAddress, async () => {
            const [{ calls: c }, b] = await Promise.all([sdk(), this.builder()]);
            const secret = b.attestationSecret;
            return tx.calls.map((call): Prepared => {
                switch (call.circuit) {
                    case 'attest':
                        return c.prepareAttest({ payloadHash: call.args[0], metadataHash: call.args[1], attestationSecret: secret });
                    case 'bindPassport':
                        return c.prepareBindPassport({ passportId: call.args[0], payloadHash: call.args[1], attestationSecret: secret });
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
                const [{ calls: c }, b] = await Promise.all([sdk(), this.builder()]);
                const secret = b.attestationSecret;
                const calls: Prepared[] = [];
                if (input.contentRoot) {
                    calls.push(c.prepareAnchorContentRoot({
                        payloadHash: input.payloadHash, contentRoot: input.contentRoot, schemaId: input.schemaId, attestationSecret: secret
                    }));
                }
                for (const claim of input.claims) calls.push(await this.prepareClaim(c, secret, input.payloadHash, claim));
                return calls;
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

    private async prepareClaim(c: any, secret: Uint8Array, payloadHash: string, claim: CartClaimArgs): Promise<Prepared> {
        if (claim.predicate === 'setMembership') {
            const set = await buildMembershipSet(claim.allowedValues);
            const path = set.proofFor(claim.value);
            if (!path) throw new Error(`remote lane: '${claim.value}' is not in the allow-list`);
            return c.prepareProveFieldMembership({
                payloadHash, fieldKey: claim.fieldKey, setRoot: set.setRoot,
                merkleProof: {
                    fieldDigest: blake2b256Hex(claim.value), fieldSalt: claim.salt,
                    siblings: claim.siblings, dirs: claim.dirs,
                    setProof: { siblings: path.setSiblings, dirs: path.setDirs }
                },
                attestationSecret: secret
            });
        }
        return c.prepareProveFieldPredicate({
            payloadHash, fieldKey: claim.fieldKey, threshold: claim.threshold,
            op: claim.predicate === 'greaterOrEqual' ? 1 : 0,
            merkleProof: { fieldValue: claim.value, fieldSalt: claim.salt, siblings: claim.siblings, dirs: claim.dirs },
            attestationSecret: secret
        });
    }

    async verifyClaimLanded(input: ClaimVerifyInput): Promise<{ verified: boolean; txHash: string }> {
        const ng = await this.client();
        const membership = input.predicate === 'setMembership';
        if (membership && !input.setRoot) return { verified: false, txHash: '' };
        const res = await ng.verifyPredicate({
            contractAddress: input.contractAddress, payloadHash: input.payloadHash, fieldKey: input.fieldKey,
            predicate: input.predicate,
            ...(membership ? { setRoot: input.setRoot } : { threshold: Number(input.threshold ?? 0) }),
            compiledArtifactRef: 'attestation-vault'
        });
        return { verified: res?.verified === true, txHash: '' };
    }

    /** Anchor effect check through the hosted API (token-authenticated). */
    async verifyAnchor(p: { contractAddress: string; payloadHash: string; contentRoot?: string; schemaId?: string }): Promise<boolean> {
        const ng = await this.client();
        const res = await ng.verifyAttestation({
            contractAddress: p.contractAddress, payloadHash: p.payloadHash,
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
    const { txbuilder } = await sdk();
    const r = await txbuilder.ensureZkAssets({
        zkConfigBaseUrl: `${cfg.apiUrl}/zk-config/attestation-vault`,
        cacheDir: cfg.cacheDir,
        circuits: REMOTE_LANE_CIRCUITS
    });
    return { fetched: Number(r?.fetched ?? 0), cached: Number(r?.cached ?? 0) };
}

/** The lane for a registered remote handle, configured from the environment. */
export function remoteLaneFor(handle: string, cfg: RemoteLaneConfig = remoteLaneConfigFromEnv()): RemoteLane {
    const signer = signers.get(handle);
    if (!signer) throw new Error(`remote chain lane: no signer registered for '${handle}'`);
    return new RemoteLane(cfg, signer.seedHex, handle.slice(0, 8));
}
