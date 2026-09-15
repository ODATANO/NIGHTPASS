/**
 * Shared ZK proof cart plan: the ordered circuit calls that prove N
 * field-bound claims on ONE record, exactly as they ride in ONE batched
 * transaction. Single source of truth for the submit paths (sibling of
 * anchor-plan.ts):
 *   - browser: app/connector/connector.mjs proveFieldPredicateBatch
 *     (wallet-signed, one approval for the whole cart)
 *   - remote lane: srv/lib/lane-remote.ts (nightgate-tx prepare helpers)
 *   - plugin lane: NIGHTGATE issueFieldPredicateAttestationBatch builds the
 *     calls itself from the same claim list
 *
 * Two claim kinds share the cart (mixed carts ride in one tx):
 *   - predicate:  proveFieldPredicate(record_key, field_key, threshold, op, valid_until)
 *   - membership: proveFieldMembership(record_key, field_key, set_root, valid_until)
 *     (the hidden value's digest + both Merkle paths travel as witnesses,
 *     never as circuit args)
 *
 * The record key names the attester's record of the payload
 * (`recordKey(attesterId, payloadHash)`, vault lineage 4); the caller
 * computes it with the vault's pure circuit. `valid_until` is the claim's
 * expiry in UNIX seconds; see `claimValidUntil`.
 *
 * Dependency-free on purpose: no @sap/cds, no Node-only APIs, so the vite
 * connector build can bundle this file for the browser.
 *
 * Cart semantics (verified against the vault contract):
 *   - Calls are independent; no cross-call ordering requirement exists (the
 *     consumers still submit through their deterministic-order batch path).
 *   - A repeated claim key only extends its expiry (never shortens it), so
 *     duplicates are merely wasted proving time; the plan drops exact
 *     duplicates and reports them.
 *   - A claim that does not hold fails the circuit assert at local proving
 *     time, BEFORE submit: one bad item aborts the whole cart with zero
 *     on-chain effect.
 */

/** The vault's cap on a claim lifetime: five years in seconds. */
export const MAX_CLAIM_LIFETIME_S = 157_680_000;

/**
 * Default claim lifetime: the cap minus one day. The circuit only accepts a
 * block whose time lies in (valid_until - cap, valid_until), so an expiry at
 * exactly now + cap would need the block to land after the local clock, and a
 * clock ahead of chain time would refuse the proof. A battery passport lives
 * longer than five years; the claim is re-proven to extend.
 */
export const DEFAULT_CLAIM_LIFETIME_S = MAX_CLAIM_LIFETIME_S - 24 * 60 * 60;

/**
 * Claim expiry in UNIX seconds. `lifetimeS` above the cap is clamped to the
 * default; a non-positive lifetime is refused.
 */
export function claimValidUntil(o: { lifetimeS?: number; nowMs?: number } = {}): number {
    const now = Math.floor((o.nowMs ?? Date.now()) / 1000);
    let life = Number(o.lifetimeS ?? DEFAULT_CLAIM_LIFETIME_S);
    if (!Number.isFinite(life) || life <= 0) throw new Error('claim lifetime must be a positive number of seconds');
    if (life > MAX_CLAIM_LIFETIME_S) life = DEFAULT_CLAIM_LIFETIME_S;
    return now + Math.floor(life);
}

export interface PredicateClaim {
    /** Absent kind means predicate (legacy callers predate the union). */
    kind?: 'predicate';
    /** blake2b-256 field key (fieldKeyHex(sourceField)), 64-hex. */
    fieldKey: string;
    /** Scaled threshold (raw x1000), non-negative integer, at most 2^63 - 1. */
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
         * [record_key 64-hex, field_key 64-hex, threshold decimal, op '0'|'1',
         * valid_until decimal UNIX seconds]. Consumers convert (browser:
         * bytes/BigInt; remote lane: the prepare helpers).
         */
        args: [string, string, string, string, string];
    }
    | {
        circuit: 'proveFieldMembership';
        /** [record_key 64-hex, field_key 64-hex, set_root 64-hex, valid_until decimal]. */
        args: [string, string, string, string];
    };

export interface ProofCartPlan {
    calls: ProofCartCall[];
    /** Deduped claims, index-aligned with `calls`. */
    claims: ProofClaim[];
    /** Exact-duplicate claims dropped from the input (wasted proving time only). */
    dropped: ProofClaim[];
    /** The expiry every call of this cart carries (UNIX seconds). */
    validUntil: number;
}

const HEX32 = /^[0-9a-fA-F]{64}$/;
const MAX_THRESHOLD = 9223372036854775807n;

function checkHex32(value: string, label: string): string {
    if (!HEX32.test(String(value ?? ''))) throw new Error(`${label} must be 32-byte hex (64 chars)`);
    return value;
}

function checkThreshold(value: number | string, label: string): string {
    const s = String(value ?? '');
    if (!/^\d+$/.test(s)) throw new Error(`${label} must be a non-negative integer (scaled Uint<64>)`);
    if (BigInt(s) > MAX_THRESHOLD) throw new Error(`${label} must be at most 2^63 - 1`);
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
 * call per claim, exact duplicates dropped, membership claims FIRST.
 *
 * Why the order: the ledger applies every GUARANTEED transcript before any
 * FALLIBLE one, and the batch pre-check refuses a guaranteed call behind a
 * fallible one (`BatchCausalityViolation`, nothing submitted). On the vault
 * `proveFieldMembership` runs guaranteed while `proveFieldPredicate` has
 * grown fallible, so a mixed cart must lead with the membership claims.
 * Same-circuit calls are unordered among themselves anyway.
 */
export function proofCartPlan({ recordKey, claims, validUntil }: {
    recordKey: string; claims: ProofClaim[]; validUntil?: number;
}): ProofCartPlan {
    checkHex32(recordKey, 'recordKey');
    if (!Array.isArray(claims) || claims.length === 0) throw new Error('the proof cart is empty');
    const expiry = Number(validUntil ?? claimValidUntil());
    if (!Number.isInteger(expiry) || expiry <= 0) throw new Error('validUntil must be a positive integer (UNIX seconds)');
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
    const ordered = [...kept.filter((c) => c.kind === 'membership'), ...kept.filter((c) => c.kind !== 'membership')];
    const until = String(expiry);
    return {
        calls: ordered.map((c): ProofCartCall => (
            c.kind === 'membership'
                ? { circuit: 'proveFieldMembership', args: [recordKey, c.fieldKey, c.setRoot, until] }
                : { circuit: 'proveFieldPredicate', args: [recordKey, c.fieldKey, String(c.threshold), String(c.op), until] }
        )),
        claims: ordered,
        dropped,
        validUntil: expiry
    };
}
