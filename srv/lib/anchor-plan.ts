/**
 * Shared on-chain anchor call plan: the AttestationVault circuit calls that
 * anchor one passport version, grouped into the transactions they may ride in.
 * Single source of truth for BOTH submit paths:
 *   - server: srv/lib/passport-anchor.ts anchorPassport (NIGHTGATE
 *     submitContractCallBatch, ordered batches since 0.10.0)
 *   - browser: app/connector/connector.mjs anchorBatch (wallet-signed, same
 *     circuits against the same vault)
 *
 * Dependency-free on purpose: no @sap/cds, no Node-only APIs, so the vite
 * connector build can bundle this file for the browser.
 *
 * WHY TWO TRANSACTIONS (0.16.x):
 * `attest` no longer only inserts. Since NIGHTGATE 0.16.0 every attestation
 * also records its creation sequence, which UPDATES the vault's sequence
 * counter cell. The ledger's sequencing check (Substrate 1010, ledger error
 * 188) rejects a batch whose update of an existing cell is followed by a later
 * intent once the contract state is populated. So attest cannot share a
 * transaction with the calls that must come after it.
 *
 * Measured on the fresh preprod vault 6523d684… (2026-08-16): the first two
 * three-call batches landed, every later one failed 1010/188, including an
 * isolated retry minutes after the previous transaction had settled. Splitting
 * the attest off is the fix; the second transaction stays a batch, with the
 * cell-UPDATING bindPassport (a same-owner rebind on re-anchor) LAST, which is
 * the shape NIGHTGATE's own 0.15.3 diagnosis found safe.
 *
 * Cost: two transactions instead of one, and in the browser lane two wallet
 * approvals instead of one. That is the price of anchoring at all on 0.16.x.
 */

export interface AnchorCall {
    circuit: 'attest' | 'bindPassport' | 'anchorContentRoot';
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
    /** blake2b-256 of the passportId (the QR binding key). */
    passportIdHash: string;
    /** Optional Merkle root over the provable fields; falsy = no anchorContentRoot call. */
    contentRoot?: string;
    /**
     * Schema id of the provable-field layout behind `contentRoot` (depth-4 root
     * over the 16 slot descriptors). MANDATORY whenever a content root is
     * anchored: since NIGHTGATE 0.16.0 `anchorContentRoot` takes it as its
     * third argument and the comparison circuit proves it describes the tree.
     */
    schemaId?: string;
}

const HEX32 = /^[0-9a-fA-F]{64}$/;

function checkHex32(value: string, label: string): string {
    if (!HEX32.test(String(value ?? ''))) throw new Error(`${label} must be 32-byte hex (64 chars)`);
    return value;
}

/**
 * The transaction plan for one anchor:
 *   tx 1: `attest(payload_hash, metadata_hash)` alone
 *   tx 2: `anchorContentRoot(payload_hash, content_root, schema_id)` (when a
 *         root is given) then `bindPassport(passportIdHash, payload_hash)`
 *
 * Both calls of tx 2 assert only state that tx 1 already committed, so their
 * order inside the transaction is a sequencing concern, not a dependency one.
 */
export function anchorTxPlan({ payloadHash, metadataHash, passportIdHash, contentRoot, schemaId }: AnchorPlanInput): AnchorTx[] {
    checkHex32(payloadHash, 'payloadHash');
    checkHex32(metadataHash, 'metadataHash');
    checkHex32(passportIdHash, 'passportIdHash');

    const rest: AnchorCall[] = [];
    if (contentRoot) {
        if (!schemaId) throw new Error('schemaId is required when a contentRoot is anchored');
        rest.push({
            circuit: 'anchorContentRoot',
            args: [payloadHash, checkHex32(contentRoot, 'contentRoot'), checkHex32(schemaId, 'schemaId')]
        });
    }
    rest.push({ circuit: 'bindPassport', args: [passportIdHash, payloadHash] });

    return [
        { label: 'attest', calls: [{ circuit: 'attest', args: [payloadHash, metadataHash] }] },
        { label: rest.map((c) => c.circuit).join('+'), calls: rest }
    ];
}

/**
 * Flat call list of the whole anchor, in apply order. Kept for callers that
 * only need "which circuits, with which arguments" (logging, step reporting);
 * anything that SUBMITS must go through `anchorTxPlan`, or it rebuilds the
 * one-transaction shape the ledger rejects.
 */
export function anchorCallPlan(input: AnchorPlanInput): AnchorCall[] {
    return anchorTxPlan(input).flatMap((tx) => tx.calls);
}
