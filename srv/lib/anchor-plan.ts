/**
 * Shared on-chain anchor call plan: the ordered AttestationVault circuit calls
 * that anchor one passport version, exactly as they ride in ONE batched
 * transaction. Single source of truth for BOTH submit paths:
 *   - server: srv/lib/passport-anchor.ts anchorPassport (NIGHTGATE
 *     submitContractCallBatch, ordered batches since 0.10.0)
 *   - browser: app/connector/connector.mjs anchorBatch (wallet-signed, same
 *     circuits against the same vault)
 *
 * Dependency-free on purpose: no @sap/cds, no Node-only APIs, so the vite
 * connector build can bundle this file for the browser.
 *
 * Call order is load-bearing: bindPassport asserts the payload hash is already
 * attested, so attest MUST apply first inside the same transaction. Both
 * consumers enforce the order at submit time (NIGHTGATE and the connector
 * rewrite the merged intents' segment ids into call order before proving).
 */

export interface AnchorCall {
    circuit: 'attest' | 'bindPassport' | 'anchorContentRoot';
    /** Bytes<32> arguments as 64-hex strings, in circuit signature order. */
    args: string[];
}

export interface AnchorPlanInput {
    /** blake2b-256 over the canonical passport payload. */
    payloadHash: string;
    /** attest metadata hash (the server uses blake2b-256 of the storage ref). */
    metadataHash: string;
    /** blake2b-256 of the passportId (the QR binding key). */
    passportIdHash: string;
    /** Optional Merkle root over the provable fields; falsy = no anchorContentRoot call. */
    contentRoot?: string;
}

const HEX32 = /^[0-9a-fA-F]{64}$/;

function checkHex32(value: string, label: string): string {
    if (!HEX32.test(String(value ?? ''))) throw new Error(`${label} must be 32-byte hex (64 chars)`);
    return value;
}

/**
 * Build the ordered call list for one anchor transaction:
 * `attest(payload_hash, metadata_hash)` then `bindPassport(passportIdHash,
 * payload_hash)` then, when a content root is given,
 * `anchorContentRoot(payload_hash, content_root)`.
 */
export function anchorCallPlan({ payloadHash, metadataHash, passportIdHash, contentRoot }: AnchorPlanInput): AnchorCall[] {
    checkHex32(payloadHash, 'payloadHash');
    checkHex32(metadataHash, 'metadataHash');
    checkHex32(passportIdHash, 'passportIdHash');
    const plan: AnchorCall[] = [
        { circuit: 'attest',       args: [payloadHash, metadataHash] },
        { circuit: 'bindPassport', args: [passportIdHash, payloadHash] }
    ];
    if (contentRoot) {
        plan.push({ circuit: 'anchorContentRoot', args: [payloadHash, checkHex32(contentRoot, 'contentRoot')] });
    }
    return plan;
}
