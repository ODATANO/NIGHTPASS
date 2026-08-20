/**
 * Shared ZK proof cart plan: the ordered circuit calls that prove N
 * field-bound claims for ONE passport, exactly as they ride in ONE batched
 * transaction. Single source of truth for the submit paths (sibling of
 * anchor-plan.ts):
 *   - browser: app/connector/connector.mjs proveFieldPredicateBatch
 *     (wallet-signed, one approval for the whole cart)
 *   - server: producer-service provePassportValuesBatch via NIGHTGATE
 *     issueFieldPredicateAttestationBatch
 *
 * Two claim kinds share the cart (mixed carts ride in one tx):
 *   - predicate:  proveFieldPredicate(payload_hash, field_key, threshold, op)
 *   - membership: proveFieldMembership(payload_hash, field_key, set_root)
 *     (the hidden value's digest + both Merkle paths travel as witnesses,
 *     never as circuit args)
 *
 * Dependency-free on purpose: no @sap/cds, no Node-only APIs, so the vite
 * connector build can bundle this file for the browser.
 *
 * Cart semantics (verified against the vault contract 2026-08-01):
 *   - Calls are independent; no cross-call ordering requirement exists (the
 *     consumers still submit through their deterministic-order batch path).
 *   - The vault does NOT reject duplicate claim keys (insert overwrites), so
 *     duplicates are merely wasted proving time; the plan drops exact
 *     duplicates and reports them.
 *   - A claim that does not hold fails the circuit assert at local proving
 *     time, BEFORE submit: one bad item aborts the whole cart with zero
 *     on-chain effect.
 */

export interface PredicateClaim {
    /** Absent kind means predicate (legacy callers predate the union). */
    kind?: 'predicate';
    /** blake2b-256 field key (fieldKeyHex(sourceField)), 64-hex. */
    fieldKey: string;
    /** Scaled threshold (raw x1000), non-negative integer, Uint<64>. */
    threshold: number | string;
    /** 0 = value <= threshold, 1 = value >= threshold. */
    op: 0 | 1;
}

export interface MembershipClaim {
    kind: 'membership';
    /** blake2b-256 field key (fieldKeyHex(sourceField)), 64-hex. */
    fieldKey: string;
    /** Canonical allow-list Merkle root, 64-hex. */
    setRoot: string;
}

export type ProofClaim = PredicateClaim | MembershipClaim;

export type ProofCartCall =
    | {
        circuit: 'proveFieldPredicate';
        /**
         * Circuit args in signature order, uniformly as strings:
         * [payload_hash 64-hex, field_key 64-hex, threshold decimal, op '0'|'1'].
         * Consumers convert (browser: bytes/BigInt; server: NIGHTGATE coercion).
         */
        args: [string, string, string, string];
    }
    | {
        circuit: 'proveFieldMembership';
        /** [payload_hash 64-hex, field_key 64-hex, set_root 64-hex]. */
        args: [string, string, string];
    };

export interface ProofCartPlan {
    calls: ProofCartCall[];
    /** Deduped claims, index-aligned with `calls`. */
    claims: ProofClaim[];
    /** Exact-duplicate claims dropped from the input (wasted proving time only). */
    dropped: ProofClaim[];
}

const HEX32 = /^[0-9a-fA-F]{64}$/;

function checkHex32(value: string, label: string): string {
    if (!HEX32.test(String(value ?? ''))) throw new Error(`${label} must be 32-byte hex (64 chars)`);
    return value;
}

function checkThreshold(value: number | string, label: string): string {
    const s = String(value ?? '');
    if (!/^\d+$/.test(s)) throw new Error(`${label} must be a non-negative integer (scaled Uint<64>)`);
    return s;
}

/**
 * Canonical dedup/join key of a claim. Predicate: `fieldKey|threshold|op`
 * (unchanged from the pre-union format); membership: `fieldKey|m|setRoot`
 * ('m' cannot collide with an all-digits threshold).
 */
export function claimKey(c: ProofClaim): string {
    if (c.kind === 'membership') return `${c.fieldKey.toLowerCase()}|m|${c.setRoot.toLowerCase()}`;
    return `${c.fieldKey.toLowerCase()}|${String(c.threshold)}|${Number(c.op)}`;
}

/**
 * Join key of a claim as the NIGHTGATE batch response/job result serializes
 * it ({ fieldKey, predicate, threshold | setRoot }). Both sides of the
 * predicateAttestationId join MUST build their key through this one function
 * (a hand-rolled twin drifting by one component makes the join miss silently
 * and rows settle without their attestation id). Returns null when the
 * kind-specific component is absent.
 */
export function responseClaimKey(c: {
    fieldKey?: string | null;
    predicate?: string | null;
    threshold?: number | string | null;
    setRoot?: string | null;
}): string | null {
    if (!c?.fieldKey || c?.predicate == null) return null;
    const mid = c.predicate === 'setMembership'
        ? String(c.setRoot ?? '').toLowerCase()
        : c.threshold != null ? String(c.threshold) : '';
    if (!mid) return null;
    return `${String(c.fieldKey).toLowerCase()}|${mid}|${c.predicate}`;
}

/**
 * Build the ordered call list for one proof cart transaction: one circuit
 * call per claim, exact duplicates dropped.
 */
export function proofCartPlan({ payloadHash, claims }: { payloadHash: string; claims: ProofClaim[] }): ProofCartPlan {
    checkHex32(payloadHash, 'payloadHash');
    if (!Array.isArray(claims) || claims.length === 0) throw new Error('the proof cart is empty');
    const seen = new Set<string>();
    const kept: ProofClaim[] = [];
    const dropped: ProofClaim[] = [];
    claims.forEach((c, i) => {
        let claim: ProofClaim;
        if (c?.kind === 'membership') {
            const fieldKey = checkHex32(c.fieldKey, `claims[${i}].fieldKey`);
            const setRoot = checkHex32(c.setRoot, `claims[${i}].setRoot`);
            claim = { kind: 'membership', fieldKey: fieldKey.toLowerCase(), setRoot: setRoot.toLowerCase() };
        } else {
            const p = c as PredicateClaim;
            const fieldKey = checkHex32(p?.fieldKey, `claims[${i}].fieldKey`);
            const threshold = checkThreshold(p?.threshold, `claims[${i}].threshold`);
            const op = Number(p?.op);
            if (op !== 0 && op !== 1) throw new Error(`claims[${i}].op must be 0 (lessOrEqual) or 1 (greaterOrEqual)`);
            claim = { fieldKey: fieldKey.toLowerCase(), threshold, op: op as 0 | 1 };
        }
        const key = claimKey(claim);
        if (seen.has(key)) { dropped.push(claim); return; }
        seen.add(key);
        kept.push(claim);
    });
    return {
        calls: kept.map((c): ProofCartCall => (
            c.kind === 'membership'
                ? { circuit: 'proveFieldMembership', args: [payloadHash, c.fieldKey, c.setRoot] }
                : { circuit: 'proveFieldPredicate', args: [payloadHash, c.fieldKey, String(c.threshold), String(c.op)] }
        )),
        claims: kept,
        dropped
    };
}
