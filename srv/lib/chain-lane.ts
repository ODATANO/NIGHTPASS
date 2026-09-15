/**
 * ChainLane: the one seam every on-chain leg of a passport goes through.
 * Callers hand over the shared plans (anchor-plan.ts, proof-plan.ts) and
 * settle their rows; the lane decides who proves, signs and submits.
 *   - lane-plugin.ts: an in-process NIGHTGATE wallet session
 *   - lane-remote.ts: a local nightgate-tx builder plus the hosted sponsor API
 * Pure module (no @sap/cds) so the types and helpers are testable anywhere.
 */
import type { AnchorTx } from './anchor-plan';
import { responseClaimKey } from './proof-plan';

export interface LaneTx {
    txHash: string;
    /** Job handle of the lane that submitted (NIGHTGATE job id on both lanes). */
    jobId: string;
}

export interface AnchorTxInput {
    contractAddress: string;
    tx: AnchorTx;
}

/**
 * One claim of a proof cart, in the wire shape of NIGHTGATE's
 * `issueFieldPredicateAttestationBatch` claimsJson entries. Key order matters:
 * the plugin lane serialises these objects as they are.
 */
export type CartClaimArgs =
    | {
        fieldKey: string;
        /** Decimal string of the scaled Uint<64> value. */
        value: string;
        salt: string;
        siblings: string[];
        dirs: boolean[];
        predicate: 'lessOrEqual' | 'greaterOrEqual';
        /** Scaled threshold (raw x1000). */
        threshold: number;
        unit?: string;
    }
    | {
        fieldKey: string;
        /** The exact string value. */
        value: string;
        allowedValues: readonly string[];
        salt: string;
        siblings: string[];
        dirs: boolean[];
        predicate: 'setMembership';
    };

export interface ProofCartInput {
    contractAddress: string;
    payloadHash: string;
    /**
     * Attester whose record of `payloadHash` carries the claims (vault
     * lineage 4 keys records by attester and payload). Absent = the lane's
     * own identity; the plugin lane then lets NIGHTGATE default it too.
     */
    attesterId?: string;
    /** Claim expiry, UNIX seconds (default: proof-plan `claimValidUntil`). */
    validUntil?: number;
    /** In-batch root anchor as the FIRST call, when no root is on-chain yet. */
    contentRoot?: string;
    schemaId?: string;
    claims: CartClaimArgs[];
    /** Wait budget; proving runs once per claim. */
    timeoutMs: number;
}

export interface ProofCartOutcome extends LaneTx {
    /** predicateAttestationId per claim, keyed by `responseClaimKey`. */
    claimIds: Map<string, string>;
}

/**
 * A proof cart that did not fully succeed. `partial` means the transaction
 * landed but the ledger's fallible phase may have applied only a subset:
 * settle every claim individually via `verifyClaimLanded`.
 */
export class ProofCartError extends Error {
    readonly partial: boolean;
    readonly jobId: string;
    readonly claimIds: Map<string, string>;
    constructor(message: string, o: { partial: boolean; jobId?: string; claimIds?: Map<string, string>; cause?: unknown }) {
        super(message, o.cause !== undefined ? { cause: o.cause } : undefined);
        this.name = 'ProofCartError';
        this.partial = o.partial;
        this.jobId = o.jobId ?? '';
        this.claimIds = o.claimIds ?? new Map();
    }
}

export interface ClaimVerifyInput {
    key: string;
    predicateAttestationId?: string;
    contractAddress: string;
    payloadHash: string;
    /** The record's attester (required by the id-free state read). */
    attesterId?: string;
    fieldKey: string;
    predicate: 'lessOrEqual' | 'greaterOrEqual' | 'setMembership';
    threshold?: number;
    setRoot?: string;
}

export interface ChainLane {
    readonly kind: 'plugin' | 'remote';
    /** The attester identity this lane signs with (64 hex), when the lane knows it without a chain read. */
    attesterId?(): Promise<string>;
    /** One transaction of the anchor plan: a single call or an ordered batch. */
    submitAnchorTx(input: AnchorTxInput): Promise<LaneTx>;
    /** The whole cart in ONE transaction. Throws ProofCartError. */
    submitProofCart(input: ProofCartInput): Promise<ProofCartOutcome>;
    /** Did this claim take effect on-chain? Used to settle a partial cart. */
    verifyClaimLanded(input: ClaimVerifyInput): Promise<{ verified: boolean; txHash: string }>;
    /** Release what the lane holds (keys, providers). Idempotent. */
    dispose(): Promise<void>;
}

/**
 * predicateAttestationId per claim from the batch action's immediate response
 * (`claims` as a JSON string) and/or the job result (`claims` as an array).
 */
export function claimIdsByKey(...sources: unknown[]): Map<string, string> {
    const out = new Map<string, string>();
    const add = (c: any) => {
        if (!c?.predicateAttestationId) return;
        const key = responseClaimKey({
            fieldKey: c?.fieldKey,
            predicate: c?.predicate ?? c?.claim?.predicate,
            threshold: c?.threshold ?? c?.claim?.threshold,
            setRoot: c?.setRoot ?? c?.claim?.setRoot
        });
        if (key) out.set(key, String(c.predicateAttestationId));
    };
    for (const src of sources) {
        let list: unknown = src;
        if (typeof src === 'string') {
            try { list = JSON.parse(src); } catch { continue; }
        }
        if (Array.isArray(list)) for (const c of list) add(c);
    }
    return out;
}
