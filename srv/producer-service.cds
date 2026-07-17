using {passport} from '../db/passport-schema';

/**
 * ProducerService: the manufacturer / ERP cockpit surface.
 *
 * Where PassportService is the read-side consumer surface (tier-gated views),
 * this is the WRITE side: a producer creates a battery passport from its Annex
 * XIII fields, saves it (draft, off-chain), runs the submit flow (attest +
 * bindPassport), manages disclosure grants, and proves the carbon-footprint
 * predicate in zero-knowledge, with a per-passport transaction overview.
 *
 * On-chain is offered BOTH ways: server-side automatic (the actions below, via
 * the NIGHTGATE plugin + a server signing session) and wallet-driven (the Fiori
 * app hands off to the Lace connector). Everything is offline-first: without a
 * session/contract the rows land with tx status `offline`.
 */
@path    : '/api/v1/producer'
@requires: 'producer'
service ProducerService {

    // Read/write the passport aggregate for the create form + list. payloadCipher
    // (the encrypted blob) is never served.
    entity Passports            as
        projection on passport.Passports
        excluding {
            payloadCipher
        };

    entity Batteries            as projection on passport.Batteries;
    entity RecycledMaterials    as projection on passport.RecycledMaterials;
    entity DiligenceDoc         as projection on passport.DiligenceDoc;
    entity PassportAttributes   as projection on passport.PassportAttributes;

    // Registered dataspace partners (recyclers / authorities) for the grant picker.
    @readonly
    entity Partners             as
        projection on passport.Partners
        excluding {
            secret
        };

    // Tracking tables (read-only projections drive the cockpit's overview tabs).
    @readonly
    entity PassportTransactions as projection on passport.PassportTransactions;

    @readonly
    entity DisclosureGrantLog   as projection on passport.DisclosureGrantLog;

    @readonly
    entity PredicateProofLog    as projection on passport.PredicateProofLog;

    /**
     * Create a passport from the passport-example fields (`passportJson` is the
     * full Annex XIII object: public Point-1 fields + batteries / recycledMaterials
     * / diligenceDocs). Always writes the row + payloadHash + encrypted payload
     * (draft). If `submit` and a signing session + contract are available, it
     * also anchors on-chain, detached like submitPassport.
     * `mode` = 'anchoring' | 'offline'.
     */
    action   createPassport(passportJson: LargeString,
                            submit: Boolean,
                            sessionId: UUID,
                            owner: String, // producer wallet identity (shielded address)
                            walletId: String // optional: which SERVER wallet signs (see listServerWallets)
    )                                                                    returns {
        passportId  : String;
        payloadHash : String;
        mode        : String;
        txHash      : String;
    };

    /**
     * The server-side producer wallets this deployment can sign with (cockpit
     * login: "server wallet" mode). One entry per configured wallet, each an
     * independent Midnight account; secrets never leave the server. Configured
     * via `PRODUCER_WALLETS` + `PRODUCER_<ID>_*` env (srv/lib/producer-wallets.ts).
     */
    function listServerWallets()                                         returns array of {
        id           : String; // pass as `walletId` to the on-chain actions
        label        : String; // display name
        owner        : String; // shielded address = the passports' owner scope
        signingReady : Boolean; // signing secrets present (can anchor)
    };

    /**
     * Open (or reuse) the signing session for a server wallet and kick off the
     * NIGHTGATE facade prewarm right away, so the first attest does not pay the
     * wallet-sync wait. Called by the cockpit when a server wallet is picked at
     * login. Returns immediately; poll `serverWalletStatus` for readiness.
     */
    action   prewarmServerWallet(walletId: String)                       returns {
        walletId : String;
        state    : String; // 'warming' | 'ready' | 'error'
        error    : String;
    };

    /**
     * Warmth of a server wallet's signing facade, for the cockpit's header
     * status surface. 'ready' means the prewarm finished, i.e. the wallet is
     * synced to the chain tip and the next attest signs without a sync wait.
     */
    function serverWalletStatus(walletId: String)                        returns {
        walletId     : String;
        state        : String; // 'cold' | 'warming' | 'ready' | 'error'
        sinceSeconds : Integer; // seconds since the session/prewarm was opened
        error        : String;
    };

    /**
     * Record a wallet-driven (in-app Lace) attest tx in the cockpit: logs a
     * PassportTransactions row and marks the passport anchored. Called by the
     * Fiori app after the browser wallet flow submits, so the transaction
     * overview reflects it (the wallet path bypasses the server actions).
     */
    action   recordWalletAttest(passportId: String,
                                txHash: String,
                                identifier: String,
                                contractAddress: String)                 returns {
        ok     : Boolean;
        txHash : String;
        status : String; // pending until the tx is verified on-chain (then succeeded/failed)
    };

    /**
     * Return a passport battery field value AND its field-bound Merkle inclusion
     * proof for the in-app Lace predicate proof. `scaledValue` is the Uint<64>
     * witness (raw ×1000); `fieldKey` is the canonical field id; `contentRoot`
     * is the Merkle root to anchor; `siblingsJson`/`dirsJson` are the inclusion
     * path. The value stays client-side (not a circuit arg).
     */
    function passportFieldValue(passportId: String, sourceField: String) returns {
        value        : String;
        scaledValue  : String;
        found        : Boolean;
        fieldKey     : String;
        contentRoot  : String;
        siblingsJson : String;
        dirsJson     : String;
    };

    /**
     * Build the Catena-X battery-passport aspect JSON: the full structured
     * passport (general + cells + recycled content + due diligence + on-chain
     * integrity). Producer-owned data, so no redaction here (the tier gating and
     * the value-hiding live on the consumer read side / in the PAC).
     */
    function passportAspectJson(passportId: String)                      returns LargeString;

    /**
     * Build the Predicate Attestation Credential (PAC) from the passport's
     * succeeded predicate proofs: a W3C-VC-shaped credential (Catena-X CX-0143)
     * carrying the attestation + each proven claim, with `valueDisclosed: false`.
     * The proven values are never included, only the claim, threshold and proof tx.
     */
    function passportCredential(passportId: String)                      returns LargeString;

    /**
     * Anchor an existing draft passport on-chain (attest + bindPassport +
     * content root). Runs DETACHED: returns `mode: 'anchoring'` immediately;
     * poll the Passports row until 'anchored' or 'failed'.
     */
    action   submitPassport(passportId: String,
                            sessionId: UUID,
                            walletId: String // optional: which SERVER wallet signs
    )                                                                    returns {
        passportId : String;
        mode       : String;
        txHash     : String;
    };

    /**
     * Record a wallet-driven (in-app Lace) disclosure grant/revoke: logs a
     * DisclosureGrantLog row (status succeeded) + a PassportTransactions row, so
     * the read gate honors it immediately (the wallet path bypasses the server).
     */
    action   recordWalletDisclosure(passportId: String,
                                    grantee: String,
                                    level: Integer,
                                    op: String, // 'grant' | 'revoke'
                                    txHash: String)                      returns {
        ok     : Boolean;
        txHash : String;
        status : String; // pending until the tx is verified on-chain (then succeeded/failed)
    };

    /**
     * Record a wallet-driven (in-app Lace) predicate proof: logs a
     * PredicateProofLog row (status succeeded) + PassportTransactions row. The
     * value stays hidden (never sent); only the claim + proof reference.
     */
    action   recordWalletPredicate(passportId: String,
                                   sourceField: String,
                                   predicate: String, // 'lessOrEqual' | 'greaterOrEqual'
                                   threshold: Integer64,
                                   unit: String,
                                   txHash: String,
                                   result: Boolean)                      returns {
        ok     : Boolean;
        txHash : String;
        status : String; // pending until the tx is verified on-chain (then succeeded/failed)
    };

    /**
     * Grant a disclosure level (0=public, 1=recycler, 2=authority) to a grantee.
     * With a signing session the chain call runs DETACHED: the action returns
     * `mode: 'granting'` immediately with the pending DisclosureGrantLog row id;
     * poll that row until it leaves 'pending'.
     */
    action   grantPassportDisclosure(passportId: String,
                                     grantee: String,
                                     level: Integer,
                                     sessionId: UUID,
                                     walletId: String // optional: which SERVER wallet signs
    )                                                                    returns {
        mode       : String; // 'granting' | 'offline'
        txHash     : String;
        grantLogId : String; // DisclosureGrantLog row to poll (mode 'granting')
    };

    /** Revoke a previously granted disclosure. Detached like grant (`mode: 'revoking'`). */
    action   revokePassportDisclosure(passportId: String,
                                      grantee: String,
                                      sessionId: UUID,
                                      walletId: String // optional: which SERVER wallet signs
    )                                                                    returns {
        mode       : String; // 'revoking' | 'offline'
        txHash     : String;
        grantLogId : String; // DisclosureGrantLog row to poll (mode 'revoking')
    };

    /**
     * Prove that a passport value satisfies a predicate against a public
     * threshold, in zero-knowledge, without revealing the value. Defaults the
     * value to the passport's battery `carbonFootprintKgCO2` when `sourceField`
     * is that field. The value is a witness and is never stored.
     *
     * With a signing session the proof runs DETACHED (like submitPassport):
     * the action returns `mode: 'proving'` immediately with the pending
     * PredicateProofLog row id; poll that row until it leaves 'pending'.
     */
    action   provePassportValue(passportId: String,
                                sourceField: String,
                                predicate: String, // 'lessOrEqual' | 'greaterOrEqual'
                                threshold: Integer64,
                                unit: String,
                                sessionId: UUID,
                                walletId: String // optional: which SERVER wallet signs
    )                                                                    returns {
        mode                   : String; // 'proving' | 'offline'
        txHash                 : String;
        predicateAttestationId : String;
        result                 : Boolean;
        proofLogId             : String; // PredicateProofLog row to poll (mode 'proving')
    };
}
