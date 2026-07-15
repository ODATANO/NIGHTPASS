using {passport} from '../db/passport-schema';

/**
 * PassportService is the NIGHTPASS consumer surface.
 *
 * Read-side projections of the passport-domain entities, co-served with the
 * NIGHTGATE plugin services on one port. `generatePassport` is the write path
 * that builds a passport from a goods-receipt batch, anchors it on Midnight
 * via the NIGHTGATE plugin (attest + bindPassport on the attestation vault)
 * and returns the QR URL.
 *
 * These projections ARE the Annex XIII disclosure boundary: after-READ
 * handlers in passport-service.ts redact every row to the caller's tier
 * (consumer / recycler / authority; on-chain grants elevate per passport).
 * `payloadCipher` is excluded so the encrypted blob is never served.
 */
// requires 'any': the viewer surface is deliberately PUBLIC (anonymous = the
// consumer tier a cold QR scan gets). Without this, NODE_ENV=production makes
// CAP demand an authenticated user for every request and the public demo host
// answers 401 to visitors. Write actions below carry their own producer gates.
@(requires: 'any')
@path: '/api/v1/passport'
service PassportService {
    @readonly
    entity Passports         as
        projection on passport.Passports
        excluding {
            payloadCipher
        };

    @readonly
    entity Batteries         as projection on passport.Batteries;

    @readonly
    entity RecycledMaterials as projection on passport.RecycledMaterials;

    @readonly
    entity DiligenceDoc      as projection on passport.DiligenceDoc;

    // Registered dataspace partners (secret never served).
    @readonly
    entity Partners          as
        projection on passport.Partners
        excluding {
            secret
        };

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
    action   registerPartner(did: String,
                             name: String,
                             role: String, // 'recycler' | 'authority'
                             secret: String)         returns {
        did       : String;
        name      : String;
        role      : String;
        granteeId : String;
    };

    /**
     * Generate a battery passport from a goods-receipt batch and anchor it on
     * Midnight. `sessionId` is a signing-enabled NIGHTGATE wallet session (from
     * connectWallet → connectWalletForSigning); when omitted, the deterministic
     * off-chain steps still run (hash, encrypt, row, QR) but no tx is submitted
     * and `attestationTxHash` is null. Useful for offline/dev runs.
     *
     * Producer-gated: passport creation is a producer write path. On a public
     * demo host an anonymous visitor must not be able to insert rows.
     */
    @(requires: 'producer')
    action   generatePassport(batchId: String,
                              sessionId: UUID)       returns {
        passportId        : String;
        attestationTxHash : String;
        qrCodeUrl         : String;
        qrCodePng         : LargeString; // data-URL PNG of qrCodeUrl
    };

    /**
     * Supplier resolution: given a passport `payloadHash` (the on-chain anchor a
     * producer shares), return the public identity + on-chain verification + the
     * tier-gated viewer URL, so a supplier can resolve the exact battery.
     */
    function resolveByHash(payloadHash: String)      returns {
        passportId        : String;
        payloadHash       : String;
        manufacturerId    : String;
        model             : String;
        batteryCategory   : String;
        contractAddress   : String;
        attestationTxHash : String;
        status            : String;
        locallyAnchored   : Boolean;
        viewerUrl         : String;
    };

    /**
     * Build a downloadable W3C-VC-style Battery Passport Credential (JSON) for a
     * passport by `payloadHash`: public subject + attestation reference + any
     * zero-knowledge predicate proofs. The artifact a supplier verifies.
     */
    function passportCredential(payloadHash: String) returns LargeString;

    /**
     * LIVE on-chain verification for the public viewer: ask the Midnight indexer
     * (crawler-free, NIGHTGATE `verifyAttestationState`) whether this passport's
     * payload hash is anchored in the attestation vault right now. Anonymous by
     * design so a QR visitor can verify a freshly created passport without an
     * account. Unlike `resolveByHash.locallyAnchored` this is NOT a DB-state
     * assertion; `verified` reflects the live ledger read.
     */
    function verifyOnChain(passportId: String)       returns {
        passportId        : String;
        status            : String; // producer lifecycle from the row
        verified          : Boolean; // live ledger read: payloadHash present in the vault
        payloadHash       : String;
        contractAddress   : String;
        anchorNetwork     : String; // network the row was anchored on (null on legacy rows)
        serverNetwork     : String; // network this host verifies against
        checkedNetwork    : String; // network the live read actually ran on (null = read skipped)
        attestationTxHash : String;
        explorerUrl       : String; // attestation tx on the anchor network's explorer
        checkedAt         : String; // ISO timestamp of this live check
    };

    /**
     * Public anchor explorer (showcase): every passport this demo issued and its
     * Midnight anchoring state, anchored rows first. Only Point-1 identity plus
     * the anchor metadata that is public by design (it lives on-chain and is
     * already served anonymously by `verifyOnChain` / `resolveByHash`). Feeds
     * the viewer's Explorer route; per-row live verification goes through
     * `verifyOnChain`.
     */
    function anchorExplorer()                        returns array of {
        passportId        : String;
        model             : String;
        manufacturerId    : String;
        batteryCategory   : String;
        manufactureDate   : String;
        weightKg          : Decimal(10, 3);
        performanceClass  : String;
        qrCodeUrl         : String;
        status            : String;
        payloadHash       : String;
        contractAddress   : String;
        anchorNetwork     : String;
        attestationTxHash : String;
        explorerUrl       : String;
        createdAt         : String;
    };
}
