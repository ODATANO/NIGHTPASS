# tractusx/: Tractus-X / Catena-X integration (usecase glue)

NIGHTPASS-side integration for exposing Battery Passport data to the Catena-X
dataspace with **ZK selective disclosure**. This is the *usecase* layer; the
cryptographic primitive (ZK predicate/range proof) is a NIGHTGATE capability, shipped in **NIGHTGATE 0.3.0** (`AttestationService.issuePredicateAttestation` /
`verifyPredicateAttestation`, verified live on preprod). See
`NIGHTGATE/docs/feature-requests/zk-predicate-attestation.md`.

**Verification model: indexer-trust (Path 1).** Midnight exposes no standalone
off-chain proof verifier, so a proof is a submitted `provePredicate` transaction
and verification = confirming via the Midnight indexer that the tx was included
and resolved to SUCCESS. The deferred "verify with only a VK, no Midnight infra"
model (Path 2) is documented but not built.

Background and rationale live in a separate Tractus-X reconnaissance workspace
(recon report + integration RFC), kept outside this repo.

## What's here

| Path | What it is |
|---|---|
| `profiles/PredicateAttestationCredential.jsonld` | The **PAC** JSON-LD profile. A verifiable-credential vocabulary that extends Catena-X's AAC (`AttributeAttestationCredential`) with a **third disclosure mode**, `zkPredicate`: prove a predicate (`value ≤ threshold`) over a hidden value. Field definitions describe the indexer-trust proof (tx hash + contract address). Destined to be contributed upstream to `eclipse-tractusx/tractusx-profiles` at `.../context/pac/v1/`. |
| `pac/build-pac.mts` | Envelope assembler **+ consumer-side verifier**. Wraps NIGHTGATE `toPredicateEnvelope` output into a full PAC verifiable credential (W3C VC + AAC + PAC contexts) so it rides the existing Catena-X "VC attached to a Digital Twin, retrieved over EDC" path, and provides `verifyPredicateViaIndexer` (the portable Path-1 check). Decoupled from `@odatano/nightgate`, consumes the output *shape*, never computes crypto. |
| `pac/samples/battery-pass-pac.json` | Generated sample PAC for the real Battery Pass `sustainability.carbonFootprint.footprintValue` field. Proof block is the real indexer-trust shape: `proofValue` = `provePredicate` tx hash, `verificationMethod` = AttestationVault contract address. |

## Run the demos

```bash
# assemble a PAC + verify it the portable way (stub indexer)
node --experimental-strip-types tractusx/pac/build-pac.mts
# -> writes pac/samples/battery-pass-pac.json
```

NIGHTPASS hosts `@odatano/nightgate` (from npm) as a CAP plugin (T16). Bring-up and
local-dev gotchas are in [`../docs/development.md`](../docs/development.md).

## The three disclosure modes (why PAC matters)

| Mode | Source | Behaviour |
|---|---|---|
| `revealedValue` | AAC-SD (exists) | value shown in clear |
| `hiddenAttributes` | AAC-SD (exists) | opaque hash; verifier needs the cleartext to check |
| **`zkPredicate`** | **PAC (this)** | prove `value ≤ threshold` in ZK; verifier never sees the value or the cleartext, it confirms the predicate held via the Midnight indexer (tx included + SUCCESS) |

## Boundary: NIGHTPASS vs NIGHTGATE

- **Here (NIGHTPASS / usecase):** PAC profile, envelope assembly, the portable
  consumer-side verify (`verifyPredicateViaIndexer`), Battery Pass field→predicate
  mapping, and (next) DTR `/credential` discovery + EDC dataplane retrieval.
- **NIGHTGATE (plugin):** the actual commitment + ZK proof generation
  (`AttestationService.issuePredicateAttestation`), on-chain submission, and the
  `verifyPredicateAttestation` chain-success check + `toPredicateEnvelope` helper.
  Shipped in 0.3.0.

## Open / follow-ups

- Wire the portable `verifyPredicateViaIndexer` to a real Midnight indexer (config
  `MIDNIGHT_INDEXER_URL`), needs the exact indexer GraphQL tx-by-hash query/field.
  The demo currently uses a stub fetcher.
- Trust anchoring for `verificationMethod` (the AttestationVault contract address):
  pin it in the issuer `did:web` doc or a Catena-X trusted-list entry so a consumer
  knows *which* contract's SUCCESS counts.
- DTR `/credential` discovery + EDC dataplane retrieval of the PAC.
- Path 2 (standalone VK verifier) remains deferred, revisit if Midnight exposes a
  JS verify API.
- Full JSON-LD expansion/validation of the profile (needs a `jsonld` lib), follow-up.
