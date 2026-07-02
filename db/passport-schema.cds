using { cuid, managed } from '@sap/cds/common';
using { midnight } from '@odatano/nightgate/db/schema';

namespace passport;

/**
 * NIGHTPASS domain schema (T17) for the EU Battery Regulation 2023/1542
 * Digital Product Passport.
 *
 * Annex XIII disclosure tiers:
 *   - Point 1        → PUBLIC               (consumer tier)
 *   - Points 2/3     → LEGITIMATE INTEREST  (recycler tier)
 *   - Points 2/3 + supplier identities → AUTHORITY (notified-body tier)
 *
 * On-chain ≠ API: only the public metadata + payload hash go to Midnight (via
 * the plugin's `Attestations`); everything else stays encrypted off-chain and
 * the disclosure tier is enforced in the API layer, not the chain. The
 * `attestation` / `documentRef` associations point at plugin-owned entities
 * (`@odatano/nightgate/db/schema`) and are never redefined here.
 */

/** Battery category per Regulation 2023/1542 Art. 2. */
type BatteryCategory : String enum {
    EV;          // electric-vehicle battery
    INDUSTRIAL;  // industrial battery (>2 kWh)
    LMT;         // light means of transport (e-bike, scooter)
}

/** Producer-cockpit lifecycle of a passport (save-then-submit split). */
type PassportStatus : String enum {
    draft;      // created off-chain, not yet anchored
    anchoring;  // submit in flight
    anchored;   // attest + bindPassport succeeded on-chain
    failed;     // last submit attempt failed
}

/** On-chain step kinds tracked in PassportTransactions (transaction overview). */
type TxKind : String enum {
    attest; bindPassport; grantDisclosure; revokeDisclosure; commitValue; provePredicate; deploy;
}

/** Status of a tracked on-chain step / log row. `offline` = no session, never submitted. */
type TxStatus : String enum { offline; pending; succeeded; failed; }

type DisclosureOp : String enum { grant; revoke; }
type PredicateOp  : String enum { lessOrEqual; greaterOrEqual; }

/** Dataspace partner role (Catena-X-style). Producers grant these tiers. */
type PartnerRole : String enum { recycler; authority; }

/**
 * Registered dataspace partners (recyclers / authorities). A partner self-
 * registers with a DID/BPN; `granteeId = sha256(utf8(did))` (NIGHTGATE `did`
 * binding) is the on-chain "who" a producer grants. `secret` is the mocked login
 * credential (stands in for the real Catena-X SSI/credential layer).
 */
entity Partners : managed {
    key did      : String(200);              // DID or BPN — the partner identity + login user
    name         : String(200);
    role         : PartnerRole;
    granteeId    : String(64);               // sha256(utf8(did)) — matches the disclosure grantee
    secret       : String(120);              // mock login password (demo only)
}

/**
 * A battery passport. The aggregate root.
 *
 * Annex XIII Point 1 (PUBLIC): batteryCategory, manufacturerId, model,
 * manufactureDate, weightKg, performanceClass. These are the fields a consumer
 * sees from the QR landing.
 */
@assert.unique: { passportId: [ passportId ] }
entity Passports : cuid, managed {
    passportId       : String(64) not null;  // unique battery ID per Regulation 2023/1542 (Point 1)
    owner            : String(160);          // producer wallet identity (shielded address); scopes the cockpit list
    manufacturerId   : String(200);          // Point 1
    batteryCategory  : BatteryCategory;      // Point 1
    model            : String(200);          // Point 1
    manufactureDate  : Date;                 // Point 1
    weightKg         : Decimal(10, 3);       // Point 1
    performanceClass : String(1);            // Point 1. A..G per regulation.
    qrCodeUrl        : String(500);          // Point 1. Public landing URL (T23).

    // Off-chain encrypted payload (T19 step 3). Holds the AES-encrypted
    // canonical payload whose blake2b-256 is the on-chain `payloadHash`. The
    // bytes never go on-chain; only the hash is attested.
    payloadCipher    : LargeBinary;

    // On-chain anchor result (written by generatePassport after submission).
    // `payloadHash` is the blake2b-256 committed via the AttestationVault
    // `attest` circuit and bound to `passportId` via `bindPassport`.
    payloadHash       : String(64);          // hex, the on-chain attestationId
    passportIdHash    : String(64);          // hex blake2b-256(passportId); on-chain bindPassport key
    contractAddress   : String(120);         // PassportAttestation deployment
    attestationTxHash : String(120);         // tx that anchored attest/bindPassport
    status            : PassportStatus default #draft;  // producer lifecycle (draft → anchored)

    // On-chain anchor. Public metadata and payload hash are committed to Midnight.
    // Plugin-owned entity; the disclosure tier is decided in the API, not here.
    attestation      : Association to midnight.Attestations;

    // Compositions hold child detail. Mixed tiers are gated per field in the service.
    batteries         : Composition of many Batteries        on batteries.passport = $self;
    recycledMaterials : Composition of many RecycledMaterials on recycledMaterials.passport = $self;
    diligenceDocs     : Composition of many DiligenceDoc      on diligenceDocs.passport = $self;
}

/**
 * Per-cell-pack detail.
 *
 * cellChemistry, capacityKwh → LEGITIMATE INTEREST (Annex XIII Points 2/3,
 * recycler tier). carbonFootprintKgCO2 → restricted (Points 2/3). supplierName
 * → AUTHORITY only (supplier identity).
 */
entity Batteries : cuid {
    passport             : Association to Passports;
    serialNumber         : String(100);      // legitimate interest
    cellChemistry        : String(50);       // legitimate interest (Points 2/3)
    capacityKwh          : Decimal(10, 3);   // legitimate interest (Points 2/3)
    carbonFootprintKgCO2 : Decimal(15, 3);   // RESTRICTED (Points 2/3). Also a ZK-predicate field.
    supplierName         : String(200);      // RESTRICTED. AUTHORITY only (supplier identity).

    // Commercially sensitive numeric fields a supplier wants to keep hidden but
    // must prove a bound on (ZK-predicate fields; see PROVABLE_FIELDS). All are
    // RESTRICTED cleartext, disclosed only via a proven predicate (value hidden).
    recycledContentPct     : Decimal(5, 2);  // Art. 8 recycled content (Co/Li/Ni). Prove '>= min quota'.
    cycleLife              : Integer;         // Annex IV full cycles to 80% SoH. Prove '>= N'.
    roundTripEfficiencyPct : Decimal(5, 2);  // Annex IV round-trip efficiency. Prove '>= X%'.
    leadContentPpm         : Decimal(10, 3);  // hazardous-substance concentration. Prove '<= limit'.
}

/**
 * Recycled-content declaration per material.
 *
 * material, recycledPercentage → LEGITIMATE INTEREST (Points 2/3, recycler
 * tier). sourceSupplierName → AUTHORITY only (supplier identity).
 */
entity RecycledMaterials : cuid {
    passport           : Association to Passports;
    material           : String(50);         // legitimate interest. Li | Co | Ni | Pb
    recycledPercentage : Decimal(5, 2);      // legitimate interest (Points 2/3)
    sourceSupplierName : String(200);        // RESTRICTED. AUTHORITY only (supplier identity).
}

/**
 * Due-diligence document reference. The bytes live off-chain at the plugin
 * `Documents.storageRef`; only the sha256 + public metadata are anchored. AUTHORITY
 * tier (Points 2/3), supply-chain due-diligence evidence.
 */
entity DiligenceDoc : cuid {
    passport    : Association to Passports;
    docType     : String(100);               // e.g. "supply-chain-due-diligence-report"
    documentRef : Association to midnight.Documents;  // plugin-owned anchor (T12)
}

/**
 * Per-passport on-chain transaction overview (producer cockpit). One row per
 * submitted step (attest, bindPassport, grant/revoke, commit/prove). `offline`
 * status = created without a signing session (no tx). Feeds the Transactions tab.
 */
entity PassportTransactions : cuid, managed {
    passport     : Association to Passports;
    kind         : TxKind;
    jobId        : String(64);
    txHash       : String(120);
    identifier   : String(120);              // 33-byte tx identifier (indexer watch key)
    status       : TxStatus default #offline;
    blockHeight  : Integer64;
    explorerUrl  : String(300);
    errorMessage : String(1000);
}

/**
 * Producer-side audit log of disclosure grants/revokes. Distinct from the
 * plugin's chain-indexed `midnight.DisclosureGrants` (read-side tier gate);
 * this records what the producer issued and its tx result.
 */
entity DisclosureGrantLog : cuid, managed {
    passport : Association to Passports;
    grantee  : String(80);                   // Bytes<32> grantee id (hex)
    level    : Integer;                      // 0=public, 1=legitimate-interest, 2=authority
    op       : DisclosureOp;
    txHash   : String(120);
    status   : TxStatus default #offline;
}

/**
 * Producer-side log of ZK predicate proofs (PAC). The hidden value is NEVER
 * stored; only the claim (field, predicate, threshold, unit) and the proof
 * reference (predicateAttestationId, txHash, result).
 */
entity PredicateProofLog : cuid, managed {
    passport               : Association to Passports;
    sourceField            : String(120);    // e.g. carbonFootprintKgCO2
    predicate              : PredicateOp;
    threshold              : Integer64;
    unit                   : String(60);
    predicateAttestationId : String(64);
    txHash                 : String(120);
    status                 : TxStatus default #offline;
    result                 : Boolean;        // proven true (tx SUCCESS) — value stays hidden
}
