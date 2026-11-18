import { anchorTxPlan } from './anchor-plan';
import type { ChainLane } from './chain-lane';
import { randomBytes } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { sortKeys, canonicalize, blake2b256Hex, hashPayload } from '@odatano/dpp-sdk/hash';
import { VALUE_SCALE, scaleValue, fieldKeyHex } from '@odatano/dpp-sdk/fields';
import { fromHex32, toHex } from '@odatano/dpp-sdk/bytes';
import { panelOf, fieldKindOf, type ProductProfile } from '@odatano/dpp-sdk/profile';
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

/** The Midnight network this server works on (`NIGHTGATE_NETWORK`, default preprod). Rows store it at anchor time. */
export function effectiveNetwork(): string {
    return process.env.NIGHTGATE_NETWORK?.trim() || 'preprod';
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
 * server-side over its public API. Fallback only: the verify service's own
 * `network` parameter is used whenever the record can be named.
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
// (`@odatano/nightgate-tx/attestation-vault` → pureCircuits.leafHash /
// nodeHash), so the off-chain root is byte-identical to the in-circuit one.
//
// Layout: a fixed depth-4 tree (16 leaves). Leaf i holds the i-th field of the
// product profile's panel (field_key = blake2b256(fieldName), value = scaled
// integer); unused leaves are a fixed empty leaf. Values are scaled x1000
// (milli-units) to match the Uint<64> predicate encoding.
//
// The panel order is part of the anchored root and the schema id, so a
// profile's panel only changes together with a re-anchor round.
export { VALUE_SCALE, scaleValue, fieldKeyHex, fromHex32, toHex, MERKLE_DEPTH, panelOf, fieldKindOf, type ProductProfile };
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
        _pureCircuitsPromise = import('@odatano/nightgate-tx/attestation-vault')
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
 * The ordered slot descriptors of a profile's panel: numeric fields are uint
 * slots at VALUE_SCALE, string fields are bytes slots, and the tail of the
 * 16-slot tree is canonical padding (the contract's own empty-leaf key, kind
 * 2, scale 0). Mirrors NIGHTGATE's computeSchemaDescriptors; the padding
 * shape is asserted IN-CIRCUIT by proveDocumentComparison, so it is not ours
 * to choose.
 */
export function schemaDescriptors(pc: VaultPureCircuits, profile: ProductProfile): SchemaDescriptor[] {
    const panel = panelOf(profile);
    if (panel.length > LEAF_COUNT) throw new Error(`profile '${profile.id}' has ${panel.length} provable fields, the tree holds ${LEAF_COUNT}`);
    const emptyKey = toHex(pc.emptyLeafKey());
    const out: SchemaDescriptor[] = [];
    for (let i = 0; i < LEAF_COUNT; i++) {
        const fieldName = panel[i];
        if (fieldName == null) out.push({ fieldKey: emptyKey, kind: 2, scale: '0' });
        else if (fieldKindOf(profile, fieldName) === 'string') out.push({ fieldKey: fieldKeyHex(fieldName), kind: 1, scale: '0' });
        else out.push({ fieldKey: fieldKeyHex(fieldName), kind: 0, scale: String(VALUE_SCALE) });
    }
    return out;
}

/** Fold the descriptor list into the schema id (depth-4 root). */
function foldSchemaId(pc: VaultPureCircuits, schema: SchemaDescriptor[]): string {
    const leaves = schema.map(d => pc.descriptorLeafHash(fromHex32(d.fieldKey), BigInt(d.kind), BigInt(d.scale)));
    return buildTree(leaves, pc.nodeHash).rootHex;
}

/** The schema id of a profile's panel. Deterministic per panel layout. */
export async function contentSchemaId(profile: ProductProfile): Promise<string> {
    const pc = await loadPureCircuits();
    return foldSchemaId(pc, schemaDescriptors(pc, profile));
}

/** Fresh 32-byte salt seed (64-hex). One per anchored version. */
export function newSaltSeed(): string {
    return randomBytes(32).toString('hex');
}

/**
 * Build the content-root Merkle tree of a profile from a field -> raw-value
 * map (raw values are scaled x1000 internally). Only panel fields are placed;
 * a field absent from `values` occupies its slot as the SALTED absent leaf.
 * Returns root, schema id, opening and a `proofFor(fieldName)` that yields
 * the inclusion path.
 *
 * Every leaf carries a per-slot salt derived from `saltSeed` via the
 * artifact's `slotSalt` circuit. Two consequences the callers must honour:
 *   - re-building the tree for a PROOF requires the SAME seed the anchor used
 *     (a fresh seed yields a different root and every claim aborts at local
 *     proving), so the seed is persisted with the passport/version;
 *   - the salts remove the dictionary attack on shared leaf hashes: the
 *     inclusion path we hand to the browser exposes sibling leaves, whose
 *     field keys are public and whose value domains are small.
 */
export async function buildContentRoot(
    profile: ProductProfile,
    values: Record<string, number | string | null | undefined>,
    opts: { saltSeed?: string | null } = {}
): Promise<ContentRoot> {
    const pc = await loadPureCircuits();
    const panel = panelOf(profile);
    const schema = schemaDescriptors(pc, profile);
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
        const fieldName = panel[i];
        const raw = fieldName != null ? values[fieldName] : undefined;
        if (fieldName != null && raw != null && raw !== '') {
            if (fieldKindOf(profile, fieldName) === 'string') {
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
            const idx = panel.indexOf(fieldName);
            if (idx < 0) return null;
            const raw = values[fieldName];
            if (raw == null || raw === '') return null;
            const { siblings, dirs } = merkleProofFor(levels, idx);
            const salt = toHex(salts[idx]);
            if (fieldKindOf(profile, fieldName) === 'string') {
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

// --- Detached work -----------------------------------------------------------

/**
 * Run `fn` with the ambient CAP transaction context cleared. Chain work
 * takes minutes, and a request transaction held open that long starves the
 * writes of the work it waits for.
 */
export function detachedFromRequest<T>(fn: () => Promise<T>): Promise<T> {
    return detachedRequestScope.runInAsyncScope(fn);
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

/** The vault contract's registered name on the NIGHTGATE API. */
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
        const { txHash, jobId } = await lane.submitVaultTx({ contractAddress, tx });
        if (!attestationTxHash) attestationTxHash = txHash;
        for (const c of tx.calls) {
            await onStep?.({ kind: c.circuit as AnchorStep['kind'], jobId, txHash });
        }
    }
    return { attestationTxHash };
}
