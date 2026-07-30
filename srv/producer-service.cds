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

    // Version history of dynamic attribute values (append-only; written by
    // updateDynamicAttributes, read by the cockpit and the DPP as-of queries).
    @readonly
    entity PassportAttributeHistory as projection on passport.PassportAttributeHistory;

    // Superseded on-chain anchor versions (re-anchoring). The old payloadCipher
    // stays in the base table only; it is never served.
    @readonly
    entity PassportAnchorVersions   as
        projection on passport.PassportAnchorVersions
        excluding {
            payloadCipher
        };

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
                            walletId: String, // optional: which SERVER wallet signs (see listServerWallets)
                            sponsorWalletId: String // optional: which pool member of PASSPORT_FEE_SPONSOR_WALLET pays the fees
    )                                                                    returns {
        passportId  : String;
        payloadHash : String;
        contentRoot : String; // 64-hex Merkle root anchored on-chain (empty when nothing to anchor); pass to verifyAttestationState
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
     * NIGHTGATE session id of a configured server wallet, opening (and
     * caching) it on first use. For trusted in-process consumers that must
     * act with an EXISTING server-wallet session instead of opening a second
     * one for the same account (two facades on one accountId wedge the wallet
     * worker; documented same-account race). The id is only usable by the
     * same authenticated user the session belongs to.
     */
    function serverWalletSession(walletId: String)                       returns {
        sessionId : String;
    };

    /**
     * Balance snapshot of the fee-sponsor POOL (PASSPORT_FEE_SPONSOR_WALLET),
     * for the ops dust monitor. Reads only sponsors whose signing session is
     * already open (boot prewarm); a cold or errored sponsor reports its state
     * rather than a balance. Never opens a session, so the call stays cheap.
     */
    function sponsorPoolStatus()                                         returns array of {
        walletId             : String;  // registry id of the sponsor wallet
        label                : String;  // display name
        state                : String;  // 'ready' | 'warming' | 'cold' | 'error'
        nightDisplay         : String;  // unshielded NIGHT in display units ('' if unknown)
        dustPresent          : Boolean; // has spendable dust to pay fees
        registeredNightUtxos : Integer; // UTxOs registered for dust generation
        healthy              : Boolean; // ready AND registered AND dust present
        error                : String;
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
     * Check a passport against the official BatteryPass-Ready validation API
     * (DIN DKE SPEC 99100). The server holds the API key and proxies the call;
     * `issues` is empty when the passport is conformant. Run before anchoring.
     */
    action   validatePassportConformance(passportId: String)             returns {
        valid      : Boolean;
        guide      : String;
        errorCount : Integer;
        checkedAt  : String;
        error      : String;   // set only on transport/config failure
        issues     : array of { path : String; message : String; };
    };

    /**
     * Upload a due-diligence evidence file for an existing passport and anchor
     * its sha256 on-chain (an own attest tx via NIGHTGATE anchorDocument; the
     * passport payloadHash stays untouched). The bytes stay off-chain in the
     * DiligenceDoc row; without a signing session the file is stored with
     * status 'offline' and can be anchored later by re-uploading.
     */
    action   uploadDiligenceDoc(passportId: String,
                                docType: String,
                                fileName: String,
                                mimeType: String,
                                contentBase64: LargeString,
                                sessionId: UUID,   // optional: browser-wallet session
                                walletId: String,  // optional: which SERVER wallet signs
                                sponsorWalletId: String // optional: fee-sponsor pool member
    )                                                                    returns {
        docId  : UUID;
        sha256 : String;
        mode   : String; // 'anchoring' | 'offline'
    };

    /** Download an uploaded due-diligence file (cockpit-side, producer-gated). */
    function diligenceFile(docId: UUID)                                  returns {
        fileName      : String;
        mimeType      : String;
        contentBase64 : LargeString;
    };

    /**
     * Re-anchor a passport after substantive content changes (re-anchoring
     * policy): recompute the payload hash from the CURRENT database state
     * (projection v2), archive the current anchor as a PassportAnchorVersions
     * row, and anchor the new hash on-chain (attest + bindPassport re-bind +
     * content root, one batched tx, detached like submitPassport; poll the
     * Passports row). The vault keeps every attested hash forever, so the
     * archived version stays verifiable. On-chain disclosure grants are per
     * version: `grantsToRegrant` lists the active grants the operator should
     * re-issue for the new version. MUST run with the SAME wallet that holds
     * the current binding (the vault rejects a foreign re-bind).
     */
    action   reanchorPassport(passportId: String,
                              reason: String, // status-change | batch-telemetry | data-correction
                              sessionId: UUID,
                              walletId: String,
                              sponsorWalletId: String
    )                                                                    returns {
        passportId          : String;
        archivedVersion     : Integer; // version number the previous anchor was stored as (0 = retry, nothing archived)
        payloadHash         : String;  // the NEW hash being anchored
        previousPayloadHash : String;
        contentRoot         : String;
        mode                : String;  // 'anchoring'
        grantsToRegrant     : array of { grantee : String; level : Integer; };
    };

    /**
     * Battery status lifecycle transition (Annex XIII 4(c)): original ->
     * repurposed | reused | remanufactured -> waste (waste is terminal). The
     * status lives in the BatteryStatus attribute row (legitimate-interest
     * tier) and is versioned in PassportAttributeHistory (source 'lifecycle').
     * Authorized actors only: producer role, plus the owner-scope check when
     * the passport has an owner and a server wallet is chosen; on-chain, only
     * the attester holding the current binding can re-anchor. Anchored
     * passports with a signing session re-anchor immediately (policy: a status
     * change is a substantive change; reason 'status-change', detached, poll
     * the row); without a session the change lands locally as drift (`mode`
     * 'offline') and the next re-anchor commits it.
     */
    action   changeBatteryStatus(passportId: String,
                                 newStatus: String, // repurposed | reused | remanufactured | waste
                                 sessionId: UUID,
                                 walletId: String,
                                 sponsorWalletId: String
    )                                                                    returns {
        passportId      : String;
        previousStatus  : String;
        newStatus       : String;
        mode            : String;  // 'anchoring' | 'offline' | 'draft'
        archivedVersion : Integer; // set in mode 'anchoring'
        payloadHash     : String;  // new hash in mode 'anchoring'
        grantsToRegrant : array of { grantee : String; level : Integer; };
    };

    /**
     * Operator handover (Second Life): transfer the passport's responsible
     * economic operator to another server wallet. On-chain the REGISTRAR (the
     * vault deployer's wallet, PASSPORT_REGISTRAR_WALLET, default 'default')
     * re-registers the passportIdHash to the new operator's attester identity;
     * from then on ONLY the new operator can (re-)bind the id, the previous
     * operator is locked out in-circuit. Off-chain the Passports.owner scope
     * flips to the new wallet on chain success, so the cockpit scoping and the
     * owner guard follow. Anchored passports run DETACHED (mode
     * 'transferring'; poll the registerPassport PassportTransactions row);
     * drafts flip the owner locally (mode 'local'). Grants stay per payload
     * version: `activeGrants` lists what the new operator should re-grant
     * after their first re-anchor.
     */
    action   transferPassportOperator(passportId: String,
                                      newWalletId: String,
                                      sponsorWalletId: String
    )                                                                    returns {
        passportId         : String;
        previousOwner      : String;
        newOwner           : String; // shielded address of the new operator wallet
        newOwnerAttesterId : String;
        mode               : String; // 'transferring' | 'local'
        activeGrants       : array of { grantee : String; level : Integer; };
    };

    /**
     * Drift check: does the passport's current database content still hash to
     * the anchored payloadHash? `drifted` is only meaningful for anchored
     * rows. Note the projection asymmetry: rows anchored under the v1
     * (creation-input) projection always report drift once compared against
     * the v2 (database) projection; the first re-anchor moves them onto v2.
     */
    function passportDrift(passportId: String)                           returns {
        passportId     : String;
        status         : String;
        drifted        : Boolean;
        currentHash    : String;
        recomputedHash : String;
    };

    /**
     * Update dynamic (telemetry / SoH) attribute values in place and append
     * version history. `updatesJson` is a JSON array of { attribute, value }
     * with RAW values (numbers / strings / { at80, at20 }); the server encodes
     * them into the exact guide shapes. Atomic: any invalid entry rejects the
     * whole batch. Only attributes from the dynamic allowlist that exist on the
     * passport are accepted; accessClass and section never change through this
     * path. Deliberately NEVER touches payloadHash or the on-chain anchor: the
     * anchor covers the creation-time snapshot (re-anchoring policy is a
     * separate concern).
     */
    action   updateDynamicAttributes(passportId: String,
                                     updatesJson: LargeString,
                                     source: String // 'bms' | 'api' (default 'api')
    )                                                                    returns {
        passportId : String;
        updated    : Integer;
        results    : array of { attribute : String; version : Integer; validFrom : String; };
    };

    /**
     * Publish an anchored passport to the public explorer instance: POST its
     * public Point-1 fields to PASSPORT_PUBLISH_URL (secret PASSPORT_PUBLISH_SECRET).
     * Only anchored passports; verification stays live on the chain at the target.
     */
    action   publishPassport(passportId: String)                         returns {
        published : Boolean;
        target    : String;
        status    : String;   // 'created' | 'updated' | error text
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
                            walletId: String, // optional: which SERVER wallet signs
                            sponsorWalletId: String // optional: pool member of PASSPORT_FEE_SPONSOR_WALLET
    )                                                                    returns {
        passportId  : String;
        contentRoot : String; // 64-hex Merkle root anchored on-chain (empty when nothing to anchor)
        mode        : String;
        txHash      : String;
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
                                walletId: String, // optional: which SERVER wallet signs
                                sponsorWalletId: String // optional: pool member of PASSPORT_FEE_SPONSOR_WALLET
    )                                                                    returns {
        mode                   : String; // 'proving' | 'offline'
        txHash                 : String;
        predicateAttestationId : String;
        result                 : Boolean;
        proofLogId             : String; // PredicateProofLog row to poll (mode 'proving')
    };
}
