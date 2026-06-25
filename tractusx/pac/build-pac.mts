/**
 * PAC envelope assembler.
 *
 * Assembles a **Predicate Attestation Credential** (PAC): a verifiable credential
 * shaped as the THIRD disclosure mode of Catena-X's AAC-SD (`zkPredicate`).
 * It consumes the OUTPUT SHAPE of NIGHTGATE's AttestationService and wraps it in
 * the W3C VC + AAC/PAC contexts so it rides the existing Catena-X "VC attached
 * to a Digital Twin, retrieved over EDC" path.
 *
 * This module intentionally does NOT import @odatano/nightgate: the crypto
 * (commitment + ZK proof + submission) is produced by NIGHTGATE; here we only
 * build the wire envelope around its output and verify it via the indexer.
 *
 * Verification model: INDEXER-TRUST (Path 1). Midnight exposes no standalone
 * off-chain proof verifier, so the proof is a submitted `provePredicate` tx and
 * verification = confirming via the Midnight indexer that the tx was included
 * and resolved to SUCCESS. The deferred Path 2 would be a standalone VK verifier.
 *
 * Run the demo:  node --experimental-strip-types tractusx/pac/build-pac.mts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Shapes. MIRROR of NIGHTGATE src/sdk/AttestationService.ts
// `PredicateAttestationEnvelope` (the `toPredicateEnvelope` return type). Keep
// these in sync with the plugin; do not diverge the field names.
// ---------------------------------------------------------------------------

export interface PredicateClaim {
  /** "lessOrEqual" | "greaterOrEqual" (Phase 1; "range" reserved). */
  predicate: string;
  /** Public bound the hidden value was proven against, a SCALED INTEGER as a string. */
  threshold: string;
  /** Unit of the threshold/value, or null. */
  unit: string | null;
}

export interface PredicateProof {
  /** Proof system id. Indexer-trust: "midnight-compact". */
  system: "midnight-compact";
  /** Circuit that produced the proof. */
  circuit: "provePredicate";
  /**
   * Indexer-trust: the AttestationVault CONTRACT ADDRESS whose SUCCESSful
   * inclusion of `proofValue` constitutes verification. (Under the deferred
   * Path 2 this would instead be a VK DID URL, distinguished by `system`.)
   */
  verificationMethod: string;
  /**
   * Indexer-trust: the `provePredicate` TRANSACTION HASH. A verifier confirms
   * it via the Midnight indexer. (Under Path 2 this would be encoded proof bytes.)
   */
  proofValue: string;
}

/** Straight from NIGHTGATE `toPredicateEnvelope(...)`. */
export interface PredicateAttestationEnvelope {
  /** On-chain persistentCommit(value, salt); null unless the issuer resolved it. */
  digestMultibase: string | null;
  claim: PredicateClaim;
  proof: PredicateProof;
}

/** One attested attribute = a NIGHTGATE envelope + where it lives in the aspect. */
export interface PredicateAttestationInput {
  /** Dotted path in the aspect, e.g. "sustainability.carbonFootprint.footprintValue". */
  attributePath: string;
  /** The envelope produced by NIGHTGATE for this attribute. */
  envelope: PredicateAttestationEnvelope;
  /** Optional unit of the ATTRIBUTE itself (claim.unit is the threshold's unit). */
  attributeUnit?: string;
  /** Attribute status; defaults to "predicate-proven". */
  status?: string;
}

// --- Credential-level metadata (issuer, validity, provenance) ---
export interface CredentialMeta {
  id: string;
  issuer: string;            // issuer DID
  validFrom: string;         // ISO 8601
  validUntil: string;        // ISO 8601
  semanticId: string;        // SAMM aspect URN, e.g. battery_pass:6.1.0#BatteryPass
  originId: string;          // DID URL of the source submodel
  originDigestMultibase?: string;
  credentialType?: string;   // aspect type tag, e.g. "BatteryPass"
  credentialStatus?: Record<string, unknown>;
  outerProof?: Record<string, unknown>; // issuer VC signature, added by the wallet
}

const AAC_CONTEXT =
  "https://raw.githubusercontent.com/eclipse-tractusx/tractusx-profiles/refs/heads/main/tx/credentials/schema/context/aac/v1/AttributeAttestationCredential.jsonld";
const PAC_CONTEXT =
  "https://raw.githubusercontent.com/eclipse-tractusx/tractusx-profiles/refs/heads/main/tx/credentials/schema/context/pac/v1/PredicateAttestationCredential.jsonld";

export function buildPredicateAttestationCredential(
  meta: CredentialMeta,
  attestations: PredicateAttestationInput[],
): Record<string, unknown> {
  if (attestations.length === 0) throw new Error("at least one attestation required");

  const credential: Record<string, unknown> = {
    "@context": [
      "https://www.w3.org/ns/credentials/v2",
      "https://w3id.org/security/data-integrity/v2",
      AAC_CONTEXT, // recognised by existing AAC tooling
      PAC_CONTEXT, // the new third-mode vocabulary
      meta.semanticId, // aspect context (Battery Pass)
    ],
    type: [
      "VerifiableCredential",
      "AttributeAttestationCredential",
      "PredicateAttestationCredential",
      ...(meta.credentialType ? [meta.credentialType] : []),
    ],
    id: meta.id,
    issuer: meta.issuer,
    validFrom: meta.validFrom,
    validUntil: meta.validUntil,
    credentialSubject: {
      attributes: attestations.map((a) => ({
        "@id": a.attributePath,
        ...(a.attributeUnit ? { unit: a.attributeUnit } : {}),
        // digestMultibase may legitimately be null under indexer-trust (the
        // commitment is not recomputable off-chain). Emit it only when present.
        ...(a.envelope.digestMultibase ? { digestMultibase: a.envelope.digestMultibase } : {}),
        disclosureMode: "zkPredicate",
        claim: stripNull(a.envelope.claim),
        proof: a.envelope.proof,
        status: a.status ?? "predicate-proven",
      })),
    },
    origin: {
      semanticId: meta.semanticId,
      "@id": meta.originId,
      "@type": "application/vc+ld+json",
      ...(meta.originDigestMultibase ? { digestMultibase: meta.originDigestMultibase } : {}),
    },
  };
  if (meta.credentialStatus) credential.credentialStatus = meta.credentialStatus;
  // outer VC signature is added by the issuer wallet; included if already present
  if (meta.outerProof) credential.proof = meta.outerProof;
  return credential;
}

function stripNull<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null),
  ) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Consumer-side verification (Path 1, indexer-trust).
//
// Reference implementation of how a Tractus-X consumer verifies a PAC attribute
// proof: look up the `provePredicate` tx via the Midnight indexer and confirm it
// was included, resolved to SUCCESS, and belongs to the expected AttestationVault
// contract. No Midnight node and no proof server, only indexer READ access.
//
// The actual indexer fetch is injected so this stays runtime-agnostic and
// testable. Wire `fetchTx` to a real Midnight indexer (config MIDNIGHT_INDEXER_URL).
// ---------------------------------------------------------------------------

export interface IndexedTx {
  /** "SUCCESS" if the ledger admitted the tx (⇒ the in-circuit asserts held). */
  applyStage: string;
  /** Contract the call targeted, for binding the proof to the expected vault. */
  contractAddress?: string;
}

export type IndexerTxFetcher = (txHash: string) => Promise<IndexedTx | null>;

export interface VerifyResult {
  verified: boolean;
  reason: string;
}

export async function verifyPredicateViaIndexer(
  envelope: PredicateAttestationEnvelope,
  fetchTx: IndexerTxFetcher,
  opts: { expectedContractAddress?: string } = {},
): Promise<VerifyResult> {
  const { proof } = envelope;
  if (proof.system !== "midnight-compact") {
    return { verified: false, reason: `unsupported proof.system '${proof.system}' (indexer-trust expects 'midnight-compact')` };
  }
  if (!proof.proofValue) {
    return { verified: false, reason: "proof.proofValue (tx hash) is empty" };
  }
  const tx = await fetchTx(proof.proofValue);
  if (!tx) return { verified: false, reason: `tx ${proof.proofValue} not found on indexer` };
  if (tx.applyStage !== "SUCCESS") {
    return { verified: false, reason: `tx ${proof.proofValue} applyStage='${tx.applyStage}' (expected SUCCESS)` };
  }
  // Bind the proof to a known vault: a SUCCESS only means SOME predicate held;
  // the consumer must trust WHICH contract issued it.
  const expected = opts.expectedContractAddress ?? proof.verificationMethod;
  if (tx.contractAddress && tx.contractAddress !== expected) {
    return { verified: false, reason: `tx contract ${tx.contractAddress} != expected ${expected}` };
  }
  return { verified: true, reason: `tx ${proof.proofValue} included + SUCCESS on vault ${expected}` };
}

// --------------------------------------------------------------------------
// Demo: assemble a PAC for the real Battery Pass carbon-footprint field using a
// MOCK envelope shaped EXACTLY like NIGHTGATE `toPredicateEnvelope` output under
// indexer-trust, then verify it against a stub indexer. Proves the end-to-end
// shape + verify path without the plugin or a live indexer installed.
//
// Scaling: kg CO2/kWh carried as milli-units (×1000) so the Uint<64> circuit
// stays integer. Footprint 47.3 → 47300; threshold 50 → 50000. These are the
// exact values proven live on preprod (47300 ≤ 50000 → accepted).
// --------------------------------------------------------------------------
async function demo(): Promise<void> {
  // What NIGHTGATE AttestationService.toPredicateEnvelope(...) returns:
  const envelope: PredicateAttestationEnvelope = {
    // on-chain persistentCommit(value, salt); issuer resolved it here so it's non-null
    digestMultibase: "mb:0x6a1f3c8e9b2d4a7f0c5e1b8d3a6f9c2e4b7d0a3f6c9e2b5d8a1f4c7e0b3d6a9f",
    claim: {
      predicate: "lessOrEqual",
      threshold: "50000", // scaled integer (50.000 kg CO2/kWh × 1000)
      unit: "milli-kg CO2 / kWh",
    },
    proof: {
      system: "midnight-compact",
      circuit: "provePredicate",
      // AttestationVault contract address (NOT a VK). The verify anchor.
      verificationMethod: "0200a3f1c47e9b6d2058e1c4a7f0b3d6e9c2a5f8b1d4e7a0c3f6b9d2e5a8c1f4b7d0",
      // the provePredicate tx hash. Verify via the Midnight indexer.
      proofValue: "6fb641b6f5e1c97f3a2b8d0e4c7a1f5b9d2e6c0a3f7b4d8e1c5a9f2b6d0e3c7a4",
    },
  };

  const meta: CredentialMeta = {
    id: "urn:uuid:pac-batterypass-carbonfootprint-0001",
    issuer: "did:web:cell-manufacturer.example",
    validFrom: "2026-06-01T00:00:00Z",
    validUntil: "2026-09-01T00:00:00Z",
    semanticId: "urn:samm:io.catenax.battery.battery_pass:6.1.0#BatteryPass",
    originId:
      "did:web:cell-manufacturer.example:api:public:urn%3Auuid%3Abatterypass-0001",
    credentialType: "BatteryPass",
    credentialStatus: {
      id: "https://issuer.example/revocation/2026/list.json#42",
      type: "BitstringStatusListEntry",
      statusPurpose: "revocation",
      statusListIndex: "42",
      statusListCredential: "https://issuer.example/revocation/2026/list.json",
    },
    // outerProof omitted. Added by the issuer wallet at signing time.
  };

  const pac = buildPredicateAttestationCredential(meta, [
    {
      attributePath: "sustainability.carbonFootprint.footprintValue",
      attributeUnit: "kg CO2 / kWh",
      envelope,
    },
  ]);
  const outPath = join(dirname(fileURLToPath(import.meta.url)), "samples", "battery-pass-pac.json");
  writeFileSync(outPath, JSON.stringify(pac, null, 2));

  // Consumer side: verify against a STUB indexer that knows this tx succeeded.
  const stubIndexer: IndexerTxFetcher = async (txHash) =>
    txHash === envelope.proof.proofValue
      ? { applyStage: "SUCCESS", contractAddress: envelope.proof.verificationMethod }
      : null;
  const result = await verifyPredicateViaIndexer(envelope, stubIndexer);

  console.log("Wrote", outPath);
  console.log("  attribute:", "sustainability.carbonFootprint.footprintValue");
  console.log("  proves:", `${envelope.claim.predicate} ${envelope.claim.threshold} ${envelope.claim.unit}`);
  console.log("  type:", (pac.type as string[]).join(", "));
  console.log("  verify (indexer-trust):", result.verified, "-", result.reason);
  console.log("  (proof = provePredicate tx hash; outer VC signature added by wallet)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  demo().catch((e) => { console.error(e); process.exit(1); });
}
