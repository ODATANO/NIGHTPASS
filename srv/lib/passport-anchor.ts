import cds from '@sap/cds';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Shared passport-anchoring primitives, used by both PassportService
 * (`generatePassport`) and the producer cockpit (ProducerService). Extracted so
 * the proven hash / encrypt / anchor / poll logic lives in one place.
 *
 * Nothing here writes to the DB; callers own persistence and (for the producer)
 * transaction-log rows via the `onStep` hook.
 */

/**
 * The Midnight network this server effectively runs on. Same precedence as the
 * NIGHTGATE plugin and the /runtime-config endpoint: env override first, then
 * cds.requires.nightgate.network. Rows store this at anchor time so a verifier
 * can tell a cross-network anchor from a failed ledger read.
 */
export function effectiveNetwork(): string {
    const cfg = ((cds.env as unknown as Record<string, any>).requires?.nightgate ?? {}) as { network?: string };
    return process.env.NIGHTGATE_NETWORK?.trim() || cfg.network || 'preview';
}

/** Public explorer URL of a transaction on the given network (both testnets exist). */
export function explorerTxUrl(txHash: string | null | undefined, network?: string | null): string | null {
    if (!txHash) return null;
    const net = network || effectiveNetwork();
    return `https://${net}.midnightexplorer.com/transactions/0x${String(txHash).replace(/^0x/, '')}`;
}

/** Parse a `net=url,net=url` env var into a network → URL map. */
function parseNetMap(envName: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of String(process.env[envName] ?? '').split(',')) {
        const i = part.indexOf('=');
        if (i > 0) {
            const net = part.slice(0, i).trim();
            const base = part.slice(i + 1).trim().replace(/\/+$/, '');
            if (net && base) out[net] = base;
        }
    }
    return out;
}

/**
 * Peer NIGHTPASS instances that verify OTHER networks, from
 * `PASSPORT_VERIFY_PEERS=preprod=http://localhost:4005,mainnet=https://...`.
 * Each peer is a second instance of this very app configured for that network
 * (shared or synced DB); verifyOnChain delegates cross-network rows to it
 * server-side over its public API. Fallback only: NIGHTGATE's native `network`
 * override on the verify surface wins whenever the loaded plugin has it.
 */
export function verifyPeers(): Record<string, string> {
    return parseNetMap('PASSPORT_VERIFY_PEERS');
}

/**
 * BROWSER-facing explorer URLs of the sibling per-network instances, from
 * `PASSPORT_EXPLORER_LINKS=preprod=https://preprod.demo.example/explorer`.
 * Distinct from PASSPORT_VERIFY_PEERS on purpose: peers are server-to-server
 * addresses (compose service names), these links must be reachable by the
 * visitor's browser. The explorer header renders them as network switch links.
 */
export function explorerLinks(): Record<string, string> {
    return parseNetMap('PASSPORT_EXPLORER_LINKS');
}

/**
 * Producer instances a PUBLIC explorer aggregates, from
 * `PASSPORT_SOURCES=cellco=https://passport.cellco.example,acme=https://...`.
 * Each producer runs its own NIGHTPASS; the explorer periodically pulls their
 * anonymous `anchorExplorer()` read surface (public Point-1 + anchor metadata,
 * exactly what is public by design) into its own database and verifies anchors
 * independently against the chain. The vault map is deliberately not
 * enumerable on-chain, so this pull is what populates a cross-producer view.
 */
export function passportSources(): Record<string, string> {
    return parseNetMap('PASSPORT_SOURCES');
}

// --- Canonical JSON + hashing ------------------------------------------------

/** Recursively sort object keys so the same logical payload always hashes equal. */
export function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>).sort()
                .map(k => [k, sortKeys((value as Record<string, unknown>)[k])])
        );
    }
    return value;
}

/** Deterministic canonical JSON string of a payload. */
export function canonicalize(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

/** blake2b-256 hex of a UTF-8 string (the on-chain hashing scheme). */
export function blake2b256Hex(input: string): string {
    return bytesToHex(blake2b(Buffer.from(input, 'utf8'), { dkLen: 32 }));
}

/** Canonicalize + hash a payload object → { canonicalPayload, payloadHash }. */
export function hashPayload(payload: unknown): { canonicalPayload: string; payloadHash: string } {
    const canonicalPayload = canonicalize(payload);
    return { canonicalPayload, payloadHash: blake2b256Hex(canonicalPayload) };
}

// --- Content-root Merkle tree (field-bound predicate hardening) --------------
//
// The predicate proof (`proveFieldPredicate`) binds a proven value to a SPECIFIC
// passport field by recomputing a Merkle leaf and folding an inclusion path up
// to a root anchored on-chain (`anchorContentRoot`). We build that same tree
// off-chain here using the contract's EXPORTED pure circuits
// (`@odatano/nightgate/browser/attestation-vault` → pureCircuits.leafHash /
// nodeHash), so the off-chain root is byte-identical to the in-circuit one.
//
// Layout: a fixed depth-4 tree (16 leaves). Leaf i holds PROVABLE_FIELDS[i]
// (field_key = blake2b256(fieldName), value = scaled integer); unused leaves are
// a fixed empty leaf. Values are scaled ×1000 (milli-units) to match the
// Uint<64> predicate encoding used by provePassportValue.

/** Provable scalar fields read directly from the (first) Battery. */
export const BATTERY_PROVABLE_FIELDS = [
    'carbonFootprintKgCO2', 'capacityKwh', 'recycledContentPct',
    'cycleLife', 'roundTripEfficiencyPct', 'leadContentPpm'
] as const;

/** Per-material recycled-content fields, sourced from RecycledMaterials rows.
 * Field key convention: `recycled<Material>Pct` (material code Co|Li|Ni|Pb). */
export const RECYCLED_MATERIAL_FIELDS = ['recycledCoPct', 'recycledLiPct', 'recycledNiPct'] as const;

/** Ordered, versioned provable-field registry. Leaf index = position here.
 * Adding a field changes the content root, so passports must be re-anchored
 * (re-attested) for the new field to become provable. */
export const PROVABLE_FIELDS = [...BATTERY_PROVABLE_FIELDS, ...RECYCLED_MATERIAL_FIELDS] as const;
export const MERKLE_DEPTH = 4;
const LEAF_COUNT = 1 << MERKLE_DEPTH; // 16
export const VALUE_SCALE = 1000;
const EMPTY_LEAF_KEY = 'nightpass/content-root/empty-leaf/v1';

function fromHex32(hex: string): Uint8Array {
    const clean = hex.replace(/^0x/, '');
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}
function toHex(u8: Uint8Array): string {
    return Buffer.from(u8).toString('hex');
}

/** Canonical 32-byte field id for a provable field name (public label hash). */
export function fieldKeyHex(fieldName: string): string {
    return blake2b256Hex(fieldName);
}

/** Scale a raw numeric field value to the Uint<64> integer the circuit compares. */
export function scaleValue(raw: number | string): number {
    return Math.round(Number(raw) * VALUE_SCALE);
}

// Memoized dynamic import of the ESM-only compiled contract (from CJS code).
let _pureCircuitsPromise: Promise<{ leafHash: (k: Uint8Array, v: bigint) => Uint8Array; nodeHash: (l: Uint8Array, r: Uint8Array) => Uint8Array }> | null = null;
async function loadPureCircuits() {
    if (!_pureCircuitsPromise) {
        _pureCircuitsPromise = import('@odatano/nightgate/browser/attestation-vault')
            .then((m: any) => m.pureCircuits);
    }
    return _pureCircuitsPromise;
}

export interface FieldMerkleProof {
    fieldKey: string;   // 64-hex canonical field id
    value: string;      // decimal string of the scaled Uint<64> value
    siblings: string[]; // MERKLE_DEPTH × 64-hex
    dirs: boolean[];     // MERKLE_DEPTH booleans (true = node is LEFT child)
}

export interface ContentRoot {
    contentRoot: string; // 64-hex Merkle root
    /** Inclusion proof for a provable field, or null if the field is not provable. */
    proofFor(fieldName: string): FieldMerkleProof | null;
}

/**
 * Build the content-root Merkle tree from a field → raw-value map (raw values
 * are scaled ×1000 internally). Only PROVABLE_FIELDS are placed; a field absent
 * from `values` still occupies its leaf as the empty leaf. Returns the root plus
 * a `proofFor(fieldName)` that yields the inclusion path.
 */
export async function buildContentRoot(values: Record<string, number | string | null | undefined>): Promise<ContentRoot> {
    const pc = await loadPureCircuits();
    const emptyLeaf = pc.leafHash(fromHex32(fieldKeyHex(EMPTY_LEAF_KEY)), 0n);

    // Leaf layer (index 0..15).
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < LEAF_COUNT; i++) {
        const fieldName = PROVABLE_FIELDS[i];
        const raw = fieldName != null ? values[fieldName] : undefined;
        if (fieldName != null && raw != null && raw !== '') {
            leaves.push(pc.leafHash(fromHex32(fieldKeyHex(fieldName)), BigInt(scaleValue(raw))));
        } else {
            leaves.push(emptyLeaf);
        }
    }

    // Build all levels bottom-up so proofFor can read siblings per level.
    const levels: Uint8Array[][] = [leaves];
    for (let d = 0; d < MERKLE_DEPTH; d++) {
        const prev = levels[d];
        const next: Uint8Array[] = [];
        for (let i = 0; i < prev.length; i += 2) {
            next.push(pc.nodeHash(prev[i], prev[i + 1]));
        }
        levels.push(next);
    }
    const contentRoot = toHex(levels[MERKLE_DEPTH][0]);

    return {
        contentRoot,
        proofFor(fieldName: string): FieldMerkleProof | null {
            const idx = PROVABLE_FIELDS.indexOf(fieldName as typeof PROVABLE_FIELDS[number]);
            if (idx < 0) return null;
            const raw = values[fieldName];
            if (raw == null || raw === '') return null;
            const siblings: string[] = [];
            const dirs: boolean[] = [];
            let node = idx;
            for (let d = 0; d < MERKLE_DEPTH; d++) {
                const isLeft = node % 2 === 0;
                const siblingIdx = isLeft ? node + 1 : node - 1;
                siblings.push(toHex(levels[d][siblingIdx]));
                dirs.push(isLeft); // true => current node is the LEFT child
                node = Math.floor(node / 2);
            }
            return {
                fieldKey: fieldKeyHex(fieldName),
                value: String(scaleValue(raw)),
                siblings,
                dirs
            };
        }
    };
}

// --- Payload encryption ------------------------------------------------------

/**
 * AES-256-GCM encrypt with a per-passport key derived via HKDF from the app
 * secret (ENCRYPTION_KEY) and passportId as salt. Output layout:
 * iv(12) || authTag(16) || ciphertext, as a Buffer for the LargeBinary column.
 */
export function encryptPayload(plaintext: string, passportId: string): Buffer {
    const masterHex = process.env.ENCRYPTION_KEY;
    const master = masterHex
        ? Buffer.from(masterHex, 'hex')
        : Buffer.from('00'.repeat(32), 'hex'); // dev fallback; prod must set ENCRYPTION_KEY
    const key = Buffer.from(
        hkdfSync('sha256', master, Buffer.from(passportId, 'utf8'), Buffer.from('passport-payload'), 32)
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
}

// --- NIGHTGATE job polling ---------------------------------------------------

/**
 * Run `fn` with the ambient CAP transaction context cleared.
 *
 * Every NIGHTGATE job flow (send the action, then poll getJobStatus) MUST run
 * outside the calling request's transaction. NIGHTGATE detaches its job work
 * to cds.spawn, and that work needs a free pooled connection plus (on SQLite)
 * the single write lock. A caller that keeps its own request tx open while
 * waiting inline starves exactly the job it is waiting on: the job can only
 * start once the caller times out and releases the connection. Diagnosed
 * live: "10-15 minutes per anchor step" was precisely the caller's own
 * waitForJob timeout; the attest itself completes in seconds once the job
 * is allowed to start.
 */
export function detachedFromRequest<T>(fn: () => Promise<T>): Promise<T> {
    return (cds as any)._with(undefined, fn);
}

/**
 * `srv.send` with NO ambient transaction at all, but WITH the caller's user
 * identity carried explicitly on the request.
 *
 * Why not `srv.tx({user}, ...)`: that wrapper holds a root tx (and, after the
 * handler's first INSERT, the sqlite write lock) for the whole action call.
 * NIGHTGATE commits its BackgroundJobs row DETACHED inside startJob,
 * on a second connection, synchronously within the same handler: with a
 * write-holding wrapper both sides wait on each other until the busy timeout
 * fires as "database is locked". So the context is cleared (every db.run in
 * the handler becomes its own short tx) and the user rides on the request
 * itself, which keeps NIGHTGATE's session-to-userId binding satisfied.
 */
export function sendDetached(nightgate: cds.Service, action: string, args: Record<string, unknown>, user?: unknown): Promise<any> {
    return detachedFromRequest(() =>
        (nightgate as any).send({ event: action, data: args, user }) as Promise<any>);
}

/**
 * Poll a NIGHTGATE async job to completion and return its parsed result
 * object. Throws on job failure. 10 min cap (120 x 5s): the ZK proof takes
 * 1.5-3s and block inclusion a few seconds more, so the cap only covers
 * proof-server queueing. Each poll runs in its own short root tx so it sees
 * the job's committed status updates.
 */
export async function waitForJobResult(nightgate: cds.Service, jobId: string, sessionId: string, user?: unknown): Promise<any> {
    for (let i = 0; i < 120; i++) {
        const job: any = await sendDetached(nightgate, 'getJobStatus', { jobId, sessionId }, user);
        if (job.status === 'succeeded') {
            return job.result ? JSON.parse(job.result) : {};
        }
        if (job.status === 'failed') {
            throw new Error(`job failed: ${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim());
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`job ${jobId} did not complete within timeout`);
}

/**
 * waitForJobResult narrowed to the common case: the job result's top-level
 * tx hash. NOT suitable for `issueFieldPredicateAttestation`, whose result is
 * a PAC envelope carrying the hash at `proof.proofValue` instead.
 */
export async function waitForJob(nightgate: cds.Service, jobId: string, sessionId: string, user?: unknown): Promise<string> {
    const result = await waitForJobResult(nightgate, jobId, sessionId, user);
    return String(result.txHash ?? '');
}

/**
 * Run one anchor step (send + poll) with a bounded retry on Substrate 1014.
 *
 * Back-to-back contract calls from the same wallet can race the wallet's own
 * dust-state update: the next tx balances against a dust note the previous tx
 * just spent, and the node rejects the submission as invalid (1014). The
 * wallet state settles as soon as its indexer stream delivers the previous
 * block, so a short backoff plus a freshly built tx resolves it. Only 1014 is
 * retried: that code means the pool rejected the tx outright, so a retry can
 * never double-anchor.
 */
async function runStep(kind: string, fn: () => Promise<string>): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 15_000));
        try { return await fn(); }
        catch (e) {
            lastErr = e;
            const msg = String((e as Error)?.message ?? e);
            // Retryable: 1014 (pool rejected the tx outright, wallet dust state
            // settling) and sqlite write contention (a facade-persist of the
            // multi-MB dust blob can hold the write lock past the busy timeout).
            if (!/\b1014\b|database is locked/i.test(msg)) break;
            cds.log('producer').warn(`anchor step ${kind} hit a retryable error (${msg.slice(0, 60)}), retrying...`);
        }
    }
    throw new Error(`${kind}: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

// --- On-chain anchor sequence ------------------------------------------------

export interface AnchorStep {
    kind: 'attest' | 'bindPassport' | 'anchorContentRoot';
    jobId: string;
    txHash: string;
}

export interface AnchorOpts {
    payloadHash: string;
    passportId: string;
    passportIdHash: string;
    contractAddress: string;
    sessionId: string;
    /**
     * Optional content-root Merkle root (64-hex) to anchor after attest, so the
     * field-bound predicate proof can bind a value to a passport field. Build it
     * with `buildContentRoot(...)`. Omit to skip the anchor step.
     */
    contentRoot?: string;
    /**
     * The CAP user the NIGHTGATE calls run as (usually the original req.user).
     * Required with detached sends: NIGHTGATE binds wallet sessions to the
     * owning userId, so the calls must carry the same identity.
     */
    user?: unknown;
    /** Called after each successful step, so callers can log a tx row. */
    onStep?: (step: AnchorStep) => Promise<void> | void;
}

// The consolidated contract shipped by the plugin. (The old separate
// `passport-attestation` artifact was folded into `attestation-vault`.)
const CONTRACT_REF = 'attestation-vault';

/**
 * Anchor a passport on-chain: `attest` → `bindPassport` (passportId →
 * payloadHash) → optional `anchorContentRoot` (Merkle root over provable
 * fields). Returns the attest tx hash. Each step polls to completion; `onStep`
 * fires per step for transaction logging.
 */
export async function anchorPassport(nightgate: cds.Service, opts: AnchorOpts): Promise<{ attestationTxHash: string }> {
    const { payloadHash, passportId, passportIdHash, contractAddress, sessionId, contentRoot, user, onStep } = opts;

    let attestJobId = '';
    const attestationTxHash = await runStep('attest', async () => {
        const anchor: any = await sendDetached(nightgate, 'anchorDocument', {
            sha256:              payloadHash,
            storageRef:          `passport://${passportId}`,
            sessionId,
            contractAddress,
            contentType:         'application/json',
            compiledArtifactRef: CONTRACT_REF
        }, user);
        attestJobId = String(anchor.jobId ?? '');
        return waitForJob(nightgate, anchor.jobId, sessionId, user);
    });
    await onStep?.({ kind: 'attest', jobId: attestJobId, txHash: attestationTxHash });

    let bindJobId = '';
    const bindTxHash = await runStep('bindPassport', async () => {
        const bind: any = await sendDetached(nightgate, 'submitContractCall', {
            contractAddress,
            circuit:             'bindPassport',
            compiledArtifactRef: CONTRACT_REF,
            sessionId,
            args:                JSON.stringify([passportIdHash, payloadHash])
        }, user);
        bindJobId = String(bind.jobId ?? '');
        return waitForJob(nightgate, bind.jobId, sessionId, user);
    });
    await onStep?.({ kind: 'bindPassport', jobId: bindJobId, txHash: bindTxHash });

    if (contentRoot) {
        let rootJobId = '';
        const rootTxHash = await runStep('anchorContentRoot', async () => {
            const root: any = await sendDetached(nightgate, 'submitContractCall', {
                contractAddress,
                circuit:             'anchorContentRoot',
                compiledArtifactRef: CONTRACT_REF,
                sessionId,
                args:                JSON.stringify([payloadHash, contentRoot])
            }, user);
            rootJobId = String(root.jobId ?? '');
            return waitForJob(nightgate, root.jobId, sessionId, user);
        });
        await onStep?.({ kind: 'anchorContentRoot', jobId: rootJobId, txHash: rootTxHash });
    }

    return { attestationTxHash };
}
