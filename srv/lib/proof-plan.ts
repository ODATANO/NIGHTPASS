/**
 * Shared ZK proof cart plan: the ordered proveFieldPredicate circuit calls
 * that prove N field-bound predicate claims for ONE passport, exactly as they
 * ride in ONE batched transaction. Single source of truth for the submit
 * paths (sibling of anchor-plan.ts):
 *   - browser: app/connector/connector.mjs proveFieldPredicateBatch
 *     (wallet-signed, one approval for the whole cart)
 *   - server: planned NIGHTGATE batch pendant of
 *     issueFieldPredicateAttestation (feature request pending); until it
 *     ships the server lane submits one tx per proof.
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
 *   - A predicate that does not hold fails the circuit assert at local
 *     proving time, BEFORE submit: one bad item aborts the whole cart with
 *     zero on-chain effect.
 */

export interface ProofClaim {
    /** blake2b-256 field key (fieldKeyHex(sourceField)), 64-hex. */
    fieldKey: string;
    /** Scaled threshold (raw x1000), non-negative integer, Uint<64>. */
    threshold: number | string;
    /** 0 = value <= threshold, 1 = value >= threshold. */
    op: 0 | 1;
}

export interface ProofCartCall {
    circuit: 'proveFieldPredicate';
    /**
     * Circuit args in signature order, uniformly as strings:
     * [payload_hash 64-hex, field_key 64-hex, threshold decimal, op '0'|'1'].
     * Consumers convert (browser: bytes/BigInt; server: NIGHTGATE coercion).
     */
    args: [string, string, string, string];
}

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
 * Build the ordered call list for one proof cart transaction: one
 * `proveFieldPredicate(payload_hash, field_key, threshold, op)` per claim,
 * exact duplicates dropped.
 */
export function proofCartPlan({ payloadHash, claims }: { payloadHash: string; claims: ProofClaim[] }): ProofCartPlan {
    checkHex32(payloadHash, 'payloadHash');
    if (!Array.isArray(claims) || claims.length === 0) throw new Error('the proof cart is empty');
    const seen = new Set<string>();
    const kept: ProofClaim[] = [];
    const dropped: ProofClaim[] = [];
    claims.forEach((c, i) => {
        const fieldKey = checkHex32(c?.fieldKey, `claims[${i}].fieldKey`);
        const threshold = checkThreshold(c?.threshold, `claims[${i}].threshold`);
        const op = Number(c?.op);
        if (op !== 0 && op !== 1) throw new Error(`claims[${i}].op must be 0 (lessOrEqual) or 1 (greaterOrEqual)`);
        const claim: ProofClaim = { fieldKey: fieldKey.toLowerCase(), threshold, op: op as 0 | 1 };
        const key = `${claim.fieldKey}|${threshold}|${op}`;
        if (seen.has(key)) { dropped.push(claim); return; }
        seen.add(key);
        kept.push(claim);
    });
    return {
        calls: kept.map((c): ProofCartCall => ({
            circuit: 'proveFieldPredicate',
            args: [payloadHash, c.fieldKey, String(c.threshold), String(c.op)]
        })),
        claims: kept,
        dropped
    };
}
