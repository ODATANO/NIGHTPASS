using { passport } from '../db/passport-schema';

/**
 * ProducerService — the manufacturer / ERP cockpit surface.
 *
 * Where PassportService is the read-side consumer surface (tier-gated views),
 * this is the WRITE side: a producer creates a battery passport from its Annex
 * XIII fields, saves it (draft, off-chain), runs the submit flow (attest +
 * bindPassport), manages disclosure grants, and proves the carbon-footprint
 * predicate in zero-knowledge — with a per-passport transaction overview.
 *
 * On-chain is offered BOTH ways: server-side automatic (the actions below, via
 * the NIGHTGATE plugin + a server signing session) and wallet-driven (the Fiori
 * app hands off to the Lace connector). Everything is offline-first: without a
 * session/contract the rows land with tx status `offline`.
 */
@path: '/api/v1/producer'
@requires: 'producer'
service ProducerService {

    // Read/write the passport aggregate for the create form + list. payloadCipher
    // (the encrypted blob) is never served.
    entity Passports         as projection on passport.Passports excluding { payloadCipher };
    entity Batteries         as projection on passport.Batteries;
    entity RecycledMaterials as projection on passport.RecycledMaterials;
    entity DiligenceDoc      as projection on passport.DiligenceDoc;

    // Registered dataspace partners (recyclers / authorities) for the grant picker.
    @readonly entity Partners as projection on passport.Partners excluding { secret };

    // Tracking tables (read-only projections drive the cockpit's overview tabs).
    @readonly entity PassportTransactions as projection on passport.PassportTransactions;
    @readonly entity DisclosureGrantLog   as projection on passport.DisclosureGrantLog;
    @readonly entity PredicateProofLog    as projection on passport.PredicateProofLog;

    /**
     * Create a passport from the passport-example fields (`passportJson` is the
     * full Annex XIII object: public Point-1 fields + batteries / recycledMaterials
     * / diligenceDocs). Always writes the row + payloadHash + encrypted payload
     * (draft). If `submit` and a signing session + contract are available, also
     * anchors it on-chain (attest + bindPassport). `mode` = 'onchain' | 'offline'.
     */
    action createPassport(
        passportJson: LargeString,
        submit:       Boolean,
        sessionId:    UUID,
        owner:        String   // producer wallet identity (shielded address)
    ) returns {
        passportId:  String;
        payloadHash: String;
        mode:        String;
        txHash:      String;
    };

    /**
     * Record a wallet-driven (in-app Lace) attest tx in the cockpit: logs a
     * PassportTransactions row and marks the passport anchored. Called by the
     * Fiori app after the browser wallet flow submits, so the transaction
     * overview reflects it (the wallet path bypasses the server actions).
     */
    action recordWalletAttest(
        passportId:      String,
        txHash:          String,
        identifier:      String,
        contractAddress: String
    ) returns {
        ok:     Boolean;
        txHash: String;
    };

    /**
     * Return a passport battery field value AND its field-bound Merkle inclusion
     * proof for the in-app Lace predicate proof. `scaledValue` is the Uint<64>
     * witness (raw ×1000); `fieldKey` is the canonical field id; `contentRoot`
     * is the Merkle root to anchor; `siblingsJson`/`dirsJson` are the inclusion
     * path. The value stays client-side (not a circuit arg).
     */
    function passportFieldValue(passportId: String, sourceField: String) returns {
        value:        String;
        scaledValue:  String;
        found:        Boolean;
        fieldKey:     String;
        contentRoot:  String;
        siblingsJson: String;
        dirsJson:     String;
    };

    /**
     * Build the Catena-X battery-passport aspect JSON: the full structured
     * passport (general + cells + recycled content + due diligence + on-chain
     * integrity). Producer-owned data, so no redaction here (the tier gating and
     * the value-hiding live on the consumer read side / in the PAC).
     */
    function passportAspectJson(passportId: String) returns LargeString;

    /**
     * Build the Predicate Attestation Credential (PAC) from the passport's
     * succeeded predicate proofs: a W3C-VC-shaped credential (Catena-X CX-0143)
     * carrying the attestation + each proven claim, with `valueDisclosed: false`.
     * The proven values are never included, only the claim, threshold and proof tx.
     */
    function passportCredential(passportId: String) returns LargeString;

    /** Anchor an existing draft passport on-chain (attest + bindPassport). */
    action submitPassport(
        passportId: String,
        sessionId:  UUID
    ) returns {
        passportId: String;
        mode:       String;
        txHash:     String;
    };

    /**
     * Record a wallet-driven (in-app Lace) disclosure grant/revoke: logs a
     * DisclosureGrantLog row (status succeeded) + a PassportTransactions row, so
     * the read gate honors it immediately (the wallet path bypasses the server).
     */
    action recordWalletDisclosure(
        passportId: String,
        grantee:    String,
        level:      Integer,
        op:         String,   // 'grant' | 'revoke'
        txHash:     String
    ) returns {
        ok:     Boolean;
        txHash: String;
    };

    /**
     * Record a wallet-driven (in-app Lace) predicate proof: logs a
     * PredicateProofLog row (status succeeded) + PassportTransactions row. The
     * value stays hidden (never sent); only the claim + proof reference.
     */
    action recordWalletPredicate(
        passportId:  String,
        sourceField: String,
        predicate:   String,   // 'lessOrEqual' | 'greaterOrEqual'
        threshold:   Integer64,
        unit:        String,
        txHash:      String,
        result:      Boolean
    ) returns {
        ok:     Boolean;
        txHash: String;
    };

    /** Grant a disclosure level (0=public, 1=recycler, 2=authority) to a grantee. */
    action grantPassportDisclosure(
        passportId: String,
        grantee:    String,
        level:      Integer,
        sessionId:  UUID
    ) returns {
        mode:   String;
        txHash: String;
    };

    /** Revoke a previously granted disclosure. */
    action revokePassportDisclosure(
        passportId: String,
        grantee:    String,
        sessionId:  UUID
    ) returns {
        mode:   String;
        txHash: String;
    };

    /**
     * Prove that a passport value satisfies a predicate against a public
     * threshold, in zero-knowledge, without revealing the value. Defaults the
     * value to the passport's battery `carbonFootprintKgCO2` when `sourceField`
     * is that field. The value is a witness — never stored.
     */
    action provePassportValue(
        passportId:  String,
        sourceField: String,
        predicate:   String,   // 'lessOrEqual' | 'greaterOrEqual'
        threshold:   Integer64,
        unit:        String,
        sessionId:   UUID
    ) returns {
        mode:                   String;
        txHash:                 String;
        predicateAttestationId: String;
        result:                 Boolean;
    };
}
