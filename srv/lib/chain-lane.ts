/**
 * ChainLane: the one seam every on-chain leg of a passport goes through (lane-remote.ts implements it).
 * Pure module without @sap/cds, so the types are testable anywhere.
 */
import type { PreparedCall } from '@odatano/nightgate-tx/txbuilder';
import type { AnchorCall } from './anchor-plan';

export interface LaneTx {
    txHash: string;
    /** NIGHTGATE job id of the sponsored submission. */
    jobId: string;
}

/** A vault circuit call. Arguments are strings in circuit order: 64 hex for Bytes<32>, decimal for numbers. */
export type VaultCall =
    | AnchorCall
    | { circuit: 'grantDisclosure'; args: [payloadHash: string, grantee: string, level: string] }
    | { circuit: 'revokeDisclosure'; args: [payloadHash: string, grantee: string] }
    | { circuit: 'registerDocument'; args: [mode: string, documentId: string, ownerId: string] };

/** One transaction: its calls ride together, in order. */
export interface VaultTx {
    /** Stable label, used for logs and step reporting. */
    label: string;
    calls: VaultCall[];
}

export interface VaultTxInput {
    contractAddress: string;
    tx: VaultTx;
}

/** The SDK's call helpers, as the server lane and the browser connector load them. */
export type VaultCallHelpers = typeof import('@odatano/nightgate-tx/calls');

/** The prepared call of one vault call, with the signer's attester secret as the witness. */
export function prepareVaultCall(c: VaultCallHelpers, secret: Uint8Array, call: VaultCall): PreparedCall {
    switch (call.circuit) {
        case 'attest':
            return c.prepareAttest({ payloadHash: call.args[0], metadataHash: call.args[1], attestationSecret: secret });
        case 'bindDocument':
            return c.prepareBindDocument({ documentId: call.args[0], payloadHash: call.args[1], attestationSecret: secret });
        case 'anchorContentRoot':
            return c.prepareAnchorContentRoot({
                payloadHash: call.args[0], contentRoot: call.args[1], schemaId: call.args[2], attestationSecret: secret
            });
        case 'grantDisclosure':
            return c.prepareGrantDisclosure({
                payloadHash: call.args[0], grantee: call.args[1], level: Number(call.args[2]), attestationSecret: secret
            });
        case 'revokeDisclosure':
            return c.prepareRevokeDisclosure({ payloadHash: call.args[0], grantee: call.args[1], attestationSecret: secret });
        case 'registerDocument':
            return c.prepareRegisterDocument({
                mode: Number(call.args[0]), documentId: call.args[1], ownerId: call.args[2], attestationSecret: secret
            });
        default:
            throw new Error(`chain lane: unsupported vault circuit '${String((call as VaultCall).circuit)}'`);
    }
}

/** One claim of a proof cart with the private inputs of its proof. */
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
    }
    | {
        fieldKey: string;
        /** blake2b-256 of the exact string the field must equal. */
        expectedDigest: string;
        salt: string;
        siblings: string[];
        dirs: boolean[];
        predicate: 'bytesEquality';
    };

export interface ProofCartInput {
    contractAddress: string;
    payloadHash: string;
    /** Attester whose record of `payloadHash` carries the claims. Absent = the lane's own identity. */
    attesterId?: string;
    /** Claim expiry, UNIX seconds (default: proof-plan `claimValidUntil`). */
    validUntil?: number;
    /** In-batch root anchor as the FIRST call, when no root is on-chain yet. */
    contentRoot?: string;
    schemaId?: string;
    claims: CartClaimArgs[];
}

/** One slot of the schema two compared versions share (kind: 0 = uint, 1 = bytes, 2 = padding). */
export interface ComparisonSchemaSlot {
    fieldKey: string;
    kind: 0 | 1 | 2;
    scale: string;
}

/** A version's private inputs for the comparison circuit. */
export interface ComparisonOpening {
    saltSeed: string;
    slots: Array<{ present: boolean; value?: string; valueDigest?: string }>;
}

/** Claims that compare two anchored versions in ONE transaction. A is the older version; the order is part of each claim key. */
export interface ComparisonInput {
    contractAddress: string;
    payloadHashA: string;
    attesterIdA: string;
    payloadHashB: string;
    attesterIdB: string;
    /** Claim expiry, UNIX seconds (default: proof-plan `claimValidUntil`). */
    validUntil?: number;
    schema: ComparisonSchemaSlot[];
    openingA: ComparisonOpening;
    openingB: ComparisonOpening;
    claims: Array<
        | { kind: 'documentIntegrity'; /** Bit i set = slot i may differ. */ allowedMask: number }
        | { kind: 'documentDiff'; /** At least k slots differ. */ k: number }
    >;
}

/** A proof cart that did not fully succeed. With `partial` the transaction may have landed in part: settle each claim via `verifyClaimLanded`. */
export class ProofCartError extends Error {
    readonly partial: boolean;
    readonly jobId: string;
    constructor(message: string, o: { partial: boolean; jobId?: string; cause?: unknown }) {
        super(message, o.cause !== undefined ? { cause: o.cause } : undefined);
        this.name = 'ProofCartError';
        this.partial = o.partial;
        this.jobId = o.jobId ?? '';
    }
}

export interface ClaimVerifyInput {
    contractAddress: string;
    payloadHash: string;
    /** The record's attester; absent = the lane's own identity. */
    attesterId?: string;
    fieldKey: string;
    predicate: 'lessOrEqual' | 'greaterOrEqual' | 'setMembership';
    threshold?: number;
    setRoot?: string;
}

export interface ChainLane {
    /** The attester identity this lane signs with (64 hex). */
    attesterId(): Promise<string>;
    /** One transaction of vault calls: a single call or an ordered batch. */
    submitVaultTx(input: VaultTxInput): Promise<LaneTx>;
    /** The whole cart in ONE transaction. Throws ProofCartError. */
    submitProofCart(input: ProofCartInput): Promise<LaneTx>;
    /** The comparison claims of two versions in ONE transaction. */
    submitComparison(input: ComparisonInput): Promise<LaneTx>;
    /** Did this claim take effect on-chain? Used to settle a partial cart. */
    verifyClaimLanded(input: ClaimVerifyInput): Promise<boolean>;
    /** Release what the lane holds (keys, providers). Idempotent. */
    dispose(): Promise<void>;
}
