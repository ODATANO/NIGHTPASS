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
}
