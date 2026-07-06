using { passport } from '../db/passport-schema';

/**
 * PassportService is the NIGHTPASS consumer surface.
 *
 * T17: read-side projections of the passport-domain entities, co-served with the
 * NIGHTGATE plugin services on one port.
 * T19: `generatePassport` is the write path that builds a passport from a batch,
 * anchors it on Midnight via the NIGHTGATE plugin (attest + bindPassport on the
 * `passport-attestation` contract), and returns the QR URL.
 *
 * Disclosure-tier gating (consumer / recycler / authority projections over Annex
 * XIII fields) lands in T20. Until then these flat projections expose everything;
 * do NOT treat this as the disclosure boundary yet. `payloadCipher` is excluded
 * from the read projection so the encrypted blob isn't served.
 */
@path: '/api/v1/passport'
service PassportService {
    @readonly entity Passports as projection on passport.Passports excluding { payloadCipher };
    @readonly entity Batteries         as projection on passport.Batteries;
    @readonly entity RecycledMaterials as projection on passport.RecycledMaterials;
    @readonly entity DiligenceDoc      as projection on passport.DiligenceDoc;

    // Registered dataspace partners (secret never served).
    @readonly entity Partners as projection on passport.Partners excluding { secret };

    /**
     * Partner registration (Catena-X-style): register a dataspace partner's
     * DID/BPN + a login secret and receive its `granteeId` (sha256(did)). Also
     * binds the DID → granteeId in the plugin's GranteeIdentities so the read gate
     * resolves the partner at read time.
     *
     * Producer-gated: partner onboarding is producer-led, not anonymous. This
     * prevents an attacker from (re)setting the secret of a DID that already holds
     * grants and then reading as that partner. An existing partner is rejected
     * (409); the secret is never rotated through this action.
     */
    @(requires: 'producer')
    action registerPartner(
        did:    String,
        name:   String,
        role:   String,   // 'recycler' | 'authority'
        secret: String
    ) returns {
        did:       String;
        name:      String;
        role:      String;
        granteeId: String;
    };

    /**
     * Generate a battery passport from a goods-receipt batch and anchor it on
     * Midnight. `sessionId` is a signing-enabled NIGHTGATE wallet session (from
     * connectWallet → connectWalletForSigning); when omitted, the deterministic
     * off-chain steps still run (hash, encrypt, row, QR) but no tx is submitted
     * and `attestationTxHash` is null. Useful for offline/dev runs.
     */
    action generatePassport(
        batchId:   String,
        sessionId: UUID
    ) returns {
        passportId:        String;
        attestationTxHash: String;
        qrCodeUrl:         String;
        qrCodePng:         LargeString;  // T23: data-URL PNG of qrCodeUrl
    };

    /**
     * Supplier resolution: given a passport `payloadHash` (the on-chain anchor a
     * producer shares), return the public identity + on-chain verification + the
     * tier-gated viewer URL, so a supplier can resolve the exact battery.
     */
    function resolveByHash(payloadHash: String) returns {
        passportId:        String;
        payloadHash:       String;
        manufacturerId:    String;
        model:             String;
        batteryCategory:   String;
        contractAddress:   String;
        attestationTxHash: String;
        status:            String;
        locallyAnchored:   Boolean;   // DB state: anchored + attest tx present (NOT a live chain re-check)
        viewerUrl:         String;    // /resolve/<hash> — tier-gated landing
    };

    /**
     * Build a downloadable W3C-VC-style Battery Passport Credential (JSON) for a
     * passport by `payloadHash`: public subject + attestation reference + any
     * zero-knowledge predicate proofs. The artifact a supplier verifies.
     */
    function passportCredential(payloadHash: String) returns LargeString;
}
