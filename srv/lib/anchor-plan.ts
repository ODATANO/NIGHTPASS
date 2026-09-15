/**
 * Shared on-chain anchor call plan: the AttestationVault circuit calls that
 * anchor one passport version, grouped into the transactions they ride in.
 * Single source of truth for every submit path:
 *   - plugin lane: srv/lib/lane-plugin.ts (NIGHTGATE submitContractCallBatch)
 *   - remote lane: srv/lib/lane-remote.ts (nightgate-tx buildSponsorable)
 *   - browser: app/connector/connector.mjs anchorBatch (wallet-signed)
 *
 * Dependency-free on purpose: no @sap/cds, no Node-only APIs, so the vite
 * connector build can bundle this file for the browser.
 *
 * Vault lineage 4 (NIGHTGATE 0.24): records are keyed by attester and payload
 * and `attest` no longer touches a cell shared with other callers, so the
 * whole anchor is ONE transaction again. Apply order follows the ledger's
 * causality rule: `attest` and `anchorContentRoot` stay in the guaranteed
 * stage as the vault grows, `bindDocument` turns fallible and must come last.
 */

export interface AnchorCall {
    circuit: 'attest' | 'bindDocument' | 'anchorContentRoot';
    /** Bytes<32> arguments as 64-hex strings, in circuit signature order. */
    args: string[];
}

/** One transaction of the anchor sequence: its calls ride in ONE tx, in order. */
export interface AnchorTx {
    /** Stable label, used for logs and step reporting. */
    label: string;
    calls: AnchorCall[];
}

export interface AnchorPlanInput {
    /** blake2b-256 over the canonical passport payload. */
    payloadHash: string;
    /** attest metadata hash (the server uses blake2b-256 of the storage ref). */
    metadataHash: string;
    /** blake2b-256 of the passportId: the document id bound on-chain (the QR binding key). */
    passportIdHash: string;
    /** Optional Merkle root over the provable fields; falsy = no anchorContentRoot call. */
    contentRoot?: string;
    /**
     * Schema id of the provable-field layout behind `contentRoot` (depth-4 root
     * over the 16 slot descriptors). Mandatory whenever a content root is
     * anchored: `anchorContentRoot` takes it as its third argument.
     */
    schemaId?: string;
}

const HEX32 = /^[0-9a-fA-F]{64}$/;

function checkHex32(value: string, label: string): string {
    if (!HEX32.test(String(value ?? ''))) throw new Error(`${label} must be 32-byte hex (64 chars)`);
    return value;
}

/**
 * The transaction plan for one anchor: ONE transaction with
 *   `attest(payload_hash, metadata_hash)`,
 *   `anchorContentRoot(payload_hash, content_root, schema_id)` (when a root is given),
 *   `bindDocument(document_id, payload_hash)` last.
 * Returned as a list so the lanes keep one loop; the list has one entry.
 */
export function anchorTxPlan({ payloadHash, metadataHash, passportIdHash, contentRoot, schemaId }: AnchorPlanInput): AnchorTx[] {
    checkHex32(payloadHash, 'payloadHash');
    checkHex32(metadataHash, 'metadataHash');
    checkHex32(passportIdHash, 'passportIdHash');

    const calls: AnchorCall[] = [{ circuit: 'attest', args: [payloadHash, metadataHash] }];
    if (contentRoot) {
        if (!schemaId) throw new Error('schemaId is required when a contentRoot is anchored');
        calls.push({
            circuit: 'anchorContentRoot',
            args: [payloadHash, checkHex32(contentRoot, 'contentRoot'), checkHex32(schemaId, 'schemaId')]
        });
    }
    calls.push({ circuit: 'bindDocument', args: [passportIdHash, payloadHash] });

    return [{ label: calls.map((c) => c.circuit).join('+'), calls }];
}

/**
 * Flat call list of the whole anchor, in apply order. For callers that only
 * need "which circuits, with which arguments" (logging, step reporting);
 * anything that submits goes through `anchorTxPlan`.
 */
export function anchorCallPlan(input: AnchorPlanInput): AnchorCall[] {
    return anchorTxPlan(input).flatMap((tx) => tx.calls);
}
