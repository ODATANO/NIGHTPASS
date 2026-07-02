import cds from '@sap/cds';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Shared passport-anchoring primitives, used by both PassportService
 * (`generatePassport`) and the producer cockpit (ProducerService). Extracted so
 * the proven hash / encrypt / anchor / poll logic lives in one place.
 *
 * Nothing here writes to the DB — callers own persistence and (for the producer)
 * transaction-log rows via the `onStep` hook.
 */

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
 * Poll a NIGHTGATE async job to completion and return its tx hash.
 * Throws on job failure. ~2.5 min cap (30 × 5s); proof and submit are slow.
 */
export async function waitForJob(nightgate: cds.Service, jobId: string, sessionId: string): Promise<string> {
    for (let i = 0; i < 30; i++) {
        const job: any = await nightgate.send('getJobStatus', { jobId, sessionId });
        if (job.status === 'succeeded') {
            const result = job.result ? JSON.parse(job.result) : {};
            return String(result.txHash ?? '');
        }
        if (job.status === 'failed') {
            throw new Error(`job failed: ${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim());
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`job ${jobId} did not complete within timeout`);
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
    const { payloadHash, passportId, passportIdHash, contractAddress, sessionId, contentRoot, onStep } = opts;

    const anchor: any = await nightgate.send('anchorDocument', {
        sha256:              payloadHash,
        storageRef:          `passport://${passportId}`,
        sessionId,
        contractAddress,
        contentType:         'application/json',
        compiledArtifactRef: CONTRACT_REF
    });
    const attestationTxHash = await waitForJob(nightgate, anchor.jobId, sessionId);
    await onStep?.({ kind: 'attest', jobId: String(anchor.jobId ?? ''), txHash: attestationTxHash });

    const bind: any = await nightgate.send('submitContractCall', {
        contractAddress,
        circuit:             'bindPassport',
        compiledArtifactRef: CONTRACT_REF,
        sessionId,
        args:                JSON.stringify([passportIdHash, payloadHash])
    });
    const bindTxHash = await waitForJob(nightgate, bind.jobId, sessionId);
    await onStep?.({ kind: 'bindPassport', jobId: String(bind.jobId ?? ''), txHash: bindTxHash });

    if (contentRoot) {
        const root: any = await nightgate.send('submitContractCall', {
            contractAddress,
            circuit:             'anchorContentRoot',
            compiledArtifactRef: CONTRACT_REF,
            sessionId,
            args:                JSON.stringify([payloadHash, contentRoot])
        });
        const rootTxHash = await waitForJob(nightgate, root.jobId, sessionId);
        await onStep?.({ kind: 'anchorContentRoot', jobId: String(root.jobId ?? ''), txHash: rootTxHash });
    }

    return { attestationTxHash };
}
