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
    carbonFootprintKgCO2 : Decimal(15, 3);   // RESTRICTED (Points 2/3). Also the ZK-predicate field.
    supplierName         : String(200);      // RESTRICTED. AUTHORITY only (supplier identity).
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
