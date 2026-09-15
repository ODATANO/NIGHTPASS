import cds from '@sap/cds';
import { anchorTxPlan } from './anchor-plan';
import type { ChainLane } from './chain-lane';
import { randomBytes } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { sortKeys, canonicalize, blake2b256Hex, hashPayload } from '@odatano/dpp-sdk/hash';
import {
    BATTERY_PROVABLE_FIELDS, RECYCLED_MATERIAL_FIELDS, DYNAMIC_PROVABLE_FIELDS,
    BATTERY_STRING_FIELDS, STRING_PROVABLE_FIELDS, PROVABLE_FIELDS, provableFieldKind,
    VALUE_SCALE, scaleValue, fieldKeyHex, fromHex32, toHex
} from '@odatano/dpp-sdk/fields';
import { MERKLE_DEPTH, LEAF_COUNT, buildTree, proofFor as merkleProofFor } from '@odatano/dpp-sdk/merkle';
import {
    encryptPayload as sdkEncryptPayload,
    decryptPayload as sdkDecryptPayload,
    masterKeyFromHex
} from '@odatano/dpp-sdk/cipher';

const detachedRequestScope = new AsyncResource('nightpass.detached-service-call');

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
    return process.env.NIGHTGATE_NETWORK?.trim() || cfg.network || 'preprod';
}

/**
 * Whether NIGHTGATE runs its block crawler. Mirrors the plugin's own resolution
 * (env `NIGHTGATE_CRAWLER_ENABLED` overrides `cds.requires.nightgate.crawler.enabled`,
 * with false/0/no/off read as off).
 */
export function crawlerEnabled(): boolean {
    const env = process.env.NIGHTGATE_CRAWLER_ENABLED?.trim();
    if (env != null && env !== '') return !/^(false|0|no|off)$/i.test(env);
    const cfg = ((cds.env as unknown as Record<string, any>).requires?.nightgate?.crawler ?? {}) as { enabled?: boolean };
    return cfg.enabled === true;
}

/**
 * Whether NIGHTGATE can advance a job's `chainStatus` past `pending` at all, i.e.
 * whether waiting on chain success can ever succeed. Two sources exist:
 *   - the block crawler (populates Transactions/TransactionResults), or
 *   - the crawler-free chain-outcome confirmer (NIGHTGATE >= 0.9.2, a per-tx
 *     indexer lookup; defaults ON when the crawler is off, opt out with
 *     `NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM=false` / `crawlerlessChainConfirm:false`).
 * Mirrors the plugin's `resolveCrawlerlessChainConfirmEnabled`. When neither runs
 * (crawler off AND confirmer opted out) chainStatus stays pending forever, so a
 * caller must not block on it (see waitForJobResult).
 */
export function chainConfirmationAvailable(): boolean {
    if (crawlerEnabled()) return true;
    const env = process.env.NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM?.trim();
    if (env != null && env !== '') return !/^(false|0|no|off)$/i.test(env);
    const cfg = ((cds.env as unknown as Record<string, any>).requires?.nightgate ?? {}) as { crawlerlessChainConfirm?: boolean };
    if (typeof cfg.crawlerlessChainConfirm === 'boolean') return cfg.crawlerlessChainConfirm;
    return true; // crawler off + no opt-out: the 0.9.2 confirmer runs by default
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
// Extracted to @odatano/dpp-sdk (shared with DAYPASS); re-exported so the
// historical import surface stays stable.
export { sortKeys, canonicalize, blake2b256Hex, hashPayload };

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

// The provable-field registry, scaling and hex helpers are extracted to
// @odatano/dpp-sdk (shared with DAYPASS: same 13-slot panel vocabulary,
// same x1000 scaling, same field-key derivation). Changing the registry
// changes the content root AND the schema id, so passports must be
// re-anchored for a new layout; extend it in ONE batch with a re-anchor
// round, never field by field.
export {
    BATTERY_PROVABLE_FIELDS, RECYCLED_MATERIAL_FIELDS, DYNAMIC_PROVABLE_FIELDS,
    BATTERY_STRING_FIELDS, STRING_PROVABLE_FIELDS, PROVABLE_FIELDS, provableFieldKind,
    VALUE_SCALE, scaleValue, fieldKeyHex, fromHex32, toHex, MERKLE_DEPTH
};
const HEX32_RE = /^[0-9a-fA-F]{64}$/;

// Memoized dynamic import of the ESM-only compiled contract (from CJS code).
// Signatures follow the 0.16.0 artifact (v4 salted leaves): every content-tree
// leaf takes a per-slot salt, and the descriptor/salt/empty-key circuits back
// the schema id. Keep this interface in sync with the artifact's PureCircuits
// type: it is a hand-written cast, so a future arity change compiles here and
// only fails at run time (as the 0.15 -> 0.16 change did).
export interface VaultPureCircuits {
    /** Ledger key of an attester's record of a payload (lineage 4). */
    recordKey: (owner: Uint8Array, payloadHash: Uint8Array) => Uint8Array;
    leafHash: (k: Uint8Array, v: bigint, salt: Uint8Array) => Uint8Array;
    nodeHash: (l: Uint8Array, r: Uint8Array) => Uint8Array;
    bytesLeafHash: (k: Uint8Array, valueDigest: Uint8Array, salt: Uint8Array) => Uint8Array;
    absentLeafHash: (k: Uint8Array, salt: Uint8Array) => Uint8Array;
    setLeafHash: (valueDigest: Uint8Array) => Uint8Array;
    descriptorLeafHash: (k: Uint8Array, kind: bigint, scale: bigint) => Uint8Array;
    slotSalt: (seed: Uint8Array, index: bigint) => Uint8Array;
    emptyLeafKey: () => Uint8Array;
}
let _pureCircuitsPromise: Promise<VaultPureCircuits> | null = null;
export async function loadPureCircuits(): Promise<VaultPureCircuits> {
    if (!_pureCircuitsPromise) {
        _pureCircuitsPromise = import('@odatano/nightgate/browser/attestation-vault')
            .then((m: any) => m.pureCircuits);
    }
    return _pureCircuitsPromise;
}

/**
 * The ledger key of an attester's record of a payload, 64 hex: what every
 * proof circuit and the id-free state reads name. Byte-identical to the
 * vault's `recordKey` pure circuit.
 */
export async function recordKeyFor(attesterId: string, payloadHash: string): Promise<string> {
    const a = String(attesterId ?? '').replace(/^0x/, '');
    const h = String(payloadHash ?? '').replace(/^0x/, '');
    if (!HEX32_RE.test(a)) throw new Error('attesterId must be 32-byte hex (64 chars)');
    if (!HEX32_RE.test(h)) throw new Error('payloadHash must be 32-byte hex (64 chars)');
    const pc = await loadPureCircuits();
    return Buffer.from(pc.recordKey(Buffer.from(a, 'hex'), Buffer.from(h, 'hex'))).toString('hex');
}

export type FieldMerkleProof =
    | {
        kind: 'numeric';
        fieldKey: string;   // 64-hex canonical field id
        value: string;      // decimal string of the scaled Uint<64> value
        salt: string;       // 64-hex per-slot salt (v4; every proof circuit needs it)
        siblings: string[]; // MERKLE_DEPTH × 64-hex
        dirs: boolean[];    // MERKLE_DEPTH booleans (true = node is LEFT child)
    }
    | {
        kind: 'string';
        fieldKey: string;      // 64-hex canonical field id
        valueDigest: string;   // 64-hex blake2b-256 of the EXACT string value
        salt: string;          // 64-hex per-slot salt (v4)
        siblings: string[];    // MERKLE_DEPTH × 64-hex
        dirs: boolean[];       // MERKLE_DEPTH booleans (true = node is LEFT child)
    };

/** One slot of the shared schema (kind: 0 = uint, 1 = bytes, 2 = padding). */
export interface SchemaDescriptor {
    fieldKey: string;
    kind: 0 | 1 | 2;
    scale: string;
}

/** One document's opening of one slot (witness material). */
export interface SlotOpening {
    present: boolean;
    /** Decimal string of the scaled Uint<64> value (uint slots). */
    value?: string;
    /** 64-hex blake2b-256 of the exact string (bytes slots). */
    valueDigest?: string;
}

/**
 * A version's full cross-root opening. WITNESS MATERIAL: `saltSeed` is the
 * commitment opening of every leaf. Store it with the anchor (losing it makes
 * the anchored root unprovable), never publish it (leaking it makes the shared
 * leaf hashes dictionary-testable again, which is exactly what v4 fixed).
 */
export interface DocumentOpening {
    saltSeed: string;
    slots: SlotOpening[];
}

export interface ContentRoot {
    contentRoot: string; // 64-hex salted Merkle root
    /** Depth-4 root over the 16 slot DESCRIPTORS; anchored next to the root and proven in-circuit. */
    schemaId: string;
    /** The seed this tree was built from (64-hex). Persist it with the anchor. */
    saltSeed: string;
    /** The descriptor list behind `schemaId` (public). */
    schema: SchemaDescriptor[];
    /** Cross-root witness bundle for proveDocumentComparison. */
    opening: DocumentOpening;
    /** Inclusion proof for a provable field, or null if the field is not provable. */
    proofFor(fieldName: string): FieldMerkleProof | null;
}

/**
 * The ordered slot descriptors of the provable-field registry: numeric fields
 * are uint slots at VALUE_SCALE, string fields are bytes slots, and the tail
 * of the 16-slot tree is canonical padding (the contract's own empty-leaf key,
 * kind 2, scale 0). Mirrors NIGHTGATE's computeSchemaDescriptors; the padding
 * shape is asserted IN-CIRCUIT by proveDocumentComparison, so it is not ours
 * to choose.
 */
export function schemaDescriptors(pc: VaultPureCircuits): SchemaDescriptor[] {
    const emptyKey = toHex(pc.emptyLeafKey());
    const out: SchemaDescriptor[] = [];
    for (let i = 0; i < LEAF_COUNT; i++) {
        const fieldName = PROVABLE_FIELDS[i];
        if (fieldName == null) out.push({ fieldKey: emptyKey, kind: 2, scale: '0' });
        else if (provableFieldKind(fieldName) === 'string') out.push({ fieldKey: fieldKeyHex(fieldName), kind: 1, scale: '0' });
        else out.push({ fieldKey: fieldKeyHex(fieldName), kind: 0, scale: String(VALUE_SCALE) });
    }
    return out;
}

/** Fold the descriptor list into the schema id (depth-4 root). */
function foldSchemaId(pc: VaultPureCircuits, schema: SchemaDescriptor[]): string {
    const leaves = schema.map(d => pc.descriptorLeafHash(fromHex32(d.fieldKey), BigInt(d.kind), BigInt(d.scale)));
    return buildTree(leaves, pc.nodeHash).rootHex;
}

/**
 * The schema id of the CURRENT provable-field registry. Deterministic: it
 * changes only when PROVABLE_FIELDS changes (which already forces a re-anchor).
 */
export async function contentSchemaId(): Promise<string> {
    const pc = await loadPureCircuits();
    return foldSchemaId(pc, schemaDescriptors(pc));
}

/** Fresh 32-byte salt seed (64-hex). One per anchored version. */
export function newSaltSeed(): string {
    return randomBytes(32).toString('hex');
}

/**
 * Build the content-root Merkle tree from a field → raw-value map (raw values
 * are scaled ×1000 internally). Only PROVABLE_FIELDS are placed; a field absent
 * from `values` occupies its slot as the SALTED absent leaf. Returns root,
 * schema id, opening and a `proofFor(fieldName)` that yields the inclusion path.
 *
 * v4 (NIGHTGATE 0.16.0): every leaf carries a per-slot salt derived from
 * `saltSeed` via the artifact's `slotSalt` circuit. Two consequences the
 * callers must honour:
 *   - re-building the tree for a PROOF requires the SAME seed the anchor used
 *     (a fresh seed yields a different root and every claim aborts at local
 *     proving), so the seed is persisted with the passport/version;
 *   - the salts remove the dictionary attack on shared leaf hashes: the
 *     inclusion path we hand to the browser exposes sibling leaves, whose
 *     field keys are public and whose value domains are small.
 */
export async function buildContentRoot(
    values: Record<string, number | string | null | undefined>,
    opts: { saltSeed?: string | null } = {}
): Promise<ContentRoot> {
    const pc = await loadPureCircuits();
    const schema = schemaDescriptors(pc);
    const saltSeedHex = opts.saltSeed && HEX32_RE.test(String(opts.saltSeed))
        ? String(opts.saltSeed).toLowerCase()
        : newSaltSeed();
    const seed = fromHex32(saltSeedHex);

    // Leaf layer (index 0..15), salted per slot.
    const leaves: Uint8Array[] = [];
    const salts: Uint8Array[] = [];
    const slots: SlotOpening[] = [];
    for (let i = 0; i < LEAF_COUNT; i++) {
        const salt = pc.slotSalt(seed, BigInt(i));
        salts.push(salt);
        const fieldName = PROVABLE_FIELDS[i];
        const raw = fieldName != null ? values[fieldName] : undefined;
        if (fieldName != null && raw != null && raw !== '') {
            if (provableFieldKind(fieldName) === 'string') {
                const digest = blake2b256Hex(String(raw));
                slots.push({ present: true, valueDigest: digest });
                leaves.push(pc.bytesLeafHash(fromHex32(fieldKeyHex(fieldName)), fromHex32(digest), salt));
            } else {
                const n = Number(raw);
                if (!Number.isFinite(n)) throw new Error(`field '${fieldName}' value is not numeric`);
                const scaled = BigInt(scaleValue(raw));
                slots.push({ present: true, value: String(scaled) });
                leaves.push(pc.leafHash(fromHex32(fieldKeyHex(fieldName)), scaled, salt));
            }
        } else {
            slots.push({ present: false });
            leaves.push(pc.absentLeafHash(fromHex32(schema[i].fieldKey), salt));
        }
    }

    // Build all levels bottom-up (shared SDK walk) so proofFor can read
    // siblings per level.
    const { levels, rootHex: contentRoot } = buildTree(leaves, pc.nodeHash);

    return {
        contentRoot,
        schemaId: foldSchemaId(pc, schema),
        saltSeed: saltSeedHex,
        schema,
        opening: { saltSeed: saltSeedHex, slots },
        proofFor(fieldName: string): FieldMerkleProof | null {
            const idx = PROVABLE_FIELDS.indexOf(fieldName as typeof PROVABLE_FIELDS[number]);
            if (idx < 0) return null;
            const raw = values[fieldName];
            if (raw == null || raw === '') return null;
            const { siblings, dirs } = merkleProofFor(levels, idx);
            const salt = toHex(salts[idx]);
            if (provableFieldKind(fieldName) === 'string') {
                return {
                    kind: 'string',
                    fieldKey: fieldKeyHex(fieldName),
                    valueDigest: blake2b256Hex(String(raw)),
                    salt,
                    siblings,
                    dirs
                };
            }
            return {
                kind: 'numeric',
                fieldKey: fieldKeyHex(fieldName),
                value: String(scaleValue(raw)),
                salt,
                siblings,
                dirs
            };
        }
    };
}

// --- Payload encryption ------------------------------------------------------

/**
 * The app secret behind every payload cipher. FAIL CLOSED: a missing or
 * malformed ENCRYPTION_KEY used to fall back to an all-zero key silently,
 * which encrypts confidential Annex XIII payloads under a publicly known key
 * and looks completely normal from the outside. Refusing to encrypt is the
 * only safe answer; `assertEncryptionKey()` turns this into a boot failure so
 * it surfaces at deploy time rather than on the first passport.
 */
export function encryptionMasterKey(): Buffer {
    const hex = String(process.env.ENCRYPTION_KEY ?? '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(
            'ENCRYPTION_KEY must be 32 bytes of hex (64 characters); refusing to encrypt passport payloads '
            + 'with a default key. Generate one with: openssl rand -hex 32');
    }
    return masterKeyFromHex(hex);
}

/** Boot-time guard so a misconfigured deployment fails loudly, not silently. */
export function assertEncryptionKey(): void {
    encryptionMasterKey();
}

/**
 * AES-256-GCM encrypt with a per-passport key derived via HKDF from the app
 * secret (ENCRYPTION_KEY) and passportId as salt. Output layout:
 * iv(12) || authTag(16) || ciphertext, as a Buffer for the LargeBinary column.
 */
export function encryptPayload(plaintext: string, passportId: string): Buffer {
    return sdkEncryptPayload(plaintext, passportId, encryptionMasterKey());
}

/**
 * Inverse of `encryptPayload`. Needed to reconstruct an ARCHIVED anchor
 * version's field values: the current rows only hold today's values, while a
 * cross-root comparison witnesses the OPENING of both versions. The archived
 * canonical payload is the only place the older values survive, so version
 * integrity is provable exactly as long as this cipher can be opened.
 *
 * Throws on a wrong key or tampered bytes (AES-GCM authenticates), which is
 * the honest outcome: a version whose payload cannot be opened cannot take
 * part in a comparison either.
 */
export function decryptPayload(cipher: Buffer | Uint8Array, passportId: string): string {
    return sdkDecryptPayload(cipher, passportId, encryptionMasterKey());
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
    return detachedRequestScope.runInAsyncScope(fn);
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
 * object. With `requireChainSuccess`, workflow completion alone is not enough:
 * polling continues until NIGHTGATE has indexed the canonical chain outcome.
 * Each poll runs in its own short root tx so it sees committed status updates.
 *
 * Chain-success enforcement applies whenever NIGHTGATE can advance `chainStatus`
 * at all: with the block crawler, or with the crawler-free confirmer (>= 0.9.2,
 * on by default when the crawler is off). Only when neither runs would the status
 * never arrive; there the server-side workflow `succeeded` is accepted and the
 * anchor is confirmed via verifyAttestationState instead.
 */
export async function waitForJobResult(
    nightgate: cds.Service,
    jobId: string,
    sessionId: string,
    user?: unknown,
    options: { requireChainSuccess?: boolean; pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<any> {
    const pollIntervalMs = options.pollIntervalMs ?? 5000;
    // 10 minutes by default, which covers an anchor batch. Proving is the leg
    // that outgrows it: a multi-claim proof cart runs one ZK proof per claim,
    // and in-process (wasm) proving is several minutes each, so those callers
    // pass a budget scaled to the claim count.
    const timeoutMs = options.timeoutMs ?? 600_000;
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
    // Only wait on chainStatus when NIGHTGATE can actually advance it.
    const enforceChain = options.requireChainSuccess === true && chainConfirmationAvailable();
    for (let i = 0; i < attempts; i++) {
        const job: any = await sendDetached(nightgate, 'getJobStatus', { jobId, sessionId }, user);
        if (job.status === 'succeeded') {
            if (enforceChain) {
                if (job.chainStatus === 'failure') {
                    const handle = job.txHash || job.submissionId || 'no submission handle persisted';
                    throw new Error(`chain execution failed (${handle}): CHAIN_EXECUTION_FAILED`);
                }
                // `succeeded` only describes NIGHTGATE's server-side workflow.
                // A submitted transaction remains pending until the indexer has
                // observed its canonical System.Events outcome.
                if (job.chainStatus !== 'success') {
                    await new Promise(r => setTimeout(r, pollIntervalMs));
                    continue;
                }
            }
            if (!job.result) return {};
            return typeof job.result === 'string' ? JSON.parse(job.result) : job.result;
        }
        if (job.status === 'failed') {
            throw new Error(`job failed: ${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim());
        }
        if (job.status === 'reconciliation_required') {
            const handle = job.txHash || job.submissionId || 'no submission handle persisted';
            throw new Error(
                `job requires reconciliation (${handle}): ` +
                `${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim()
            );
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`job ${jobId} did not complete within timeout`);
}

/**
 * waitForJobResult narrowed to the common case: the job result's top-level
 * tx hash. NOT suitable for `issueFieldPredicateAttestation`, whose result is
 * a PAC envelope carrying the hash at `proof.proofValue` instead.
 */
export async function waitForJob(nightgate: cds.Service, jobId: string, sessionId: string, user?: unknown): Promise<string> {
    const result = await waitForJobResult(nightgate, jobId, sessionId, user, { requireChainSuccess: true });
    const txHash = result.txHash ?? result.txId;
    if (!txHash) throw new Error(`chain job ${jobId} succeeded without a transaction hash`);
    return String(txHash);
}

/**
 * Run one chain step (send + poll) with a bounded retry on Substrate 1014.
 * Used by the anchor sequence below AND by the proof paths in
 * ProducerService: both submit back-to-back calls from the same wallet.
 *
 * Back-to-back contract calls from the same wallet can race the wallet's own
 * dust-state update: the next tx balances against a dust note the previous tx
 * just spent, and the node rejects the submission as invalid (1014). The
 * wallet state settles as soon as its indexer stream delivers the previous
 * block, so a short backoff plus a freshly built tx resolves it. Only 1014 is
 * retried: that code means the pool rejected the tx outright, so a retry can
 * never double-anchor.
 */
export async function runChainStep<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 15_000));
        try { return await fn(); }
        catch (e) {
            lastErr = e;
            const msg = String((e as Error)?.message ?? e);
            // Retryable, and only these:
            //   1014      the pool rejected the tx outright (wallet dust state
            //             settling),
            //   1010/170  InvalidDustSpendProof: the dust note this tx spends
            //             moved between build and submit. Hit reliably on the
            //             SECOND transaction of the split anchor, which is
            //             built right after the first one spent dust. A retry
            //             rebuilds against fresh dust state.
            //   sqlite write contention (a facade-persist of the multi-MB dust
            //             blob can hold the write lock past the busy timeout).
            // All three are provably pre-mempool, so a retry can never
            // double-anchor. Deliberately NOT retried: 1010/188 (the ledger's
            // sequencing check) is deterministic for a given batch shape, so
            // retrying only burns proving time; and upstream HTTP 4xx, whose
            // 'Received status code 4xx' string is the GraphQL client's generic
            // error for EVERY indexer call, including reads AFTER the node
            // accepted the tx, so retrying could resubmit a landed tx.
            if (!/\b1014\b|\b1010\/170\b|database is locked/i.test(msg)) break;
            cds.log('producer').warn(`${kind} hit a retryable error (${msg.slice(0, 60)}), retrying...`);
        }
    }
    throw new Error(`${kind}: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

// --- On-chain anchor sequence ------------------------------------------------

export interface AnchorStep {
    kind: 'attest' | 'bindDocument' | 'anchorContentRoot';
    jobId: string;
    txHash: string;
}

export interface AnchorOpts {
    payloadHash: string;
    passportId: string;
    passportIdHash: string;
    contractAddress: string;
    /**
     * Optional content-root Merkle root (64-hex) to anchor after attest, so the
     * field-bound predicate proof can bind a value to a passport field. Build it
     * with `buildContentRoot(...)`. Omit to skip the anchor step.
     */
    contentRoot?: string;
    /**
     * Schema id of that root (`buildContentRoot(...).schemaId`). Required
     * whenever `contentRoot` is set: `anchorContentRoot` takes it as its third
     * argument since NIGHTGATE 0.16.0 and the cross-root comparison circuit
     * proves it describes the tree.
     */
    schemaId?: string;
    /** Called after each successful step, so callers can log a tx row. */
    onStep?: (step: AnchorStep) => Promise<void> | void;
}

/** The consolidated contract shipped by the plugin, also served by the hosted API. */
export const CONTRACT_REF = 'attestation-vault';

/**
 * Anchor a passport on-chain through a ChainLane: `attest`, then
 * `anchorContentRoot` (when a root is given), then `bindDocument`, as ONE
 * transaction (lineage 4). The plan comes from `anchorTxPlan`, the same
 * source the browser connector consumes, so the submit paths cannot drift.
 * Returns the tx hash. `onStep` fires once per circuit; the steps share the
 * jobId/txHash of their transaction.
 */
export async function anchorPassport(lane: ChainLane, opts: AnchorOpts): Promise<{ attestationTxHash: string }> {
    const { payloadHash, passportId, passportIdHash, contractAddress, contentRoot, schemaId, onStep } = opts;
    if (contentRoot && !schemaId) {
        throw new Error('anchorPassport: schemaId is required alongside contentRoot (the third anchorContentRoot argument)');
    }
    const txPlan = anchorTxPlan({
        payloadHash,
        metadataHash: blake2b256Hex(`passport://${passportId}`),
        passportIdHash,
        ...(contentRoot ? { contentRoot, schemaId } : {})
    });
    let attestationTxHash = '';
    for (const tx of txPlan) {
        const { txHash, jobId } = await lane.submitAnchorTx({ contractAddress, tx });
        if (!attestationTxHash) attestationTxHash = txHash;
        for (const c of tx.calls) {
            await onStep?.({ kind: c.circuit as AnchorStep['kind'], jobId, txHash });
        }
    }
    return { attestationTxHash };
}
