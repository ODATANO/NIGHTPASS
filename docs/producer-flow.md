# Producer flow: steps and transactions

The end-to-end lifecycle of one passport, which steps produce an on-chain transaction, and how to read those transactions in the explorer. The guiding rule: **passport data never goes on-chain**; the chain only ever holds hashes, entitlements, and proofs.

For cockpit screenshots per step see the [producer walkthrough](producer-walkthrough.md); for the security model and the field-bound proof construction see the [architecture](architecture.md).

## The flow, step by step

1. **Connect wallet** (no tx). The cockpit reads the shielded address from Lace; that address *is* the producer identity and scopes the passport list to the owner. No login, no central user store: holding the key is holding the identity.
2. **Create passport** (no tx, deliberately). `createPassport` canonicalizes the Annex XIII payload, computes the blake2b-256 `payloadHash`, encrypts the payload with AES-256-GCM (HKDF key per passport), and stores an off-chain draft. Creating data is ERP territory; anchoring it is a separate, wallet-signed decision.
3. **Attest** (one transaction). The anchor writes three things on the `attestation-vault`: `attest` locks the `payloadHash` under the attester identity (any later change to the payload is detectable), `bindPassport` binds `passportId -> payloadHash` for QR resolution, and `anchorContentRoot` anchors a Merkle root over the provable fields for later field-bound proofs. Since NIGHTGATE 0.10.0 all three circuit calls ride in ONE batched transaction with deterministic apply order. Only after this does the cockpit enable Grant / Revoke / Prove / Share.
4. **Register partner** (no tx). Self-service registry mapping a Catena-X BPN to a `granteeId` (`Bytes<32>`), the partner's on-chain identity as a grant target.
5. **Grant disclosure** (tx `grantDisclosure(payloadHash, grantee, level)`). Writes the entitlement on-chain: this partner may see this passport up to level 0 (consumer), 1 (recycler) or 2 (authority), mirroring the Annex XIII tiers. Entitlement is enforced on-chain and auditable; cleartext delivery stays in the API layer, which reads the grant and redacts accordingly (a public ledger cannot decrypt per role).
6. **Prove** (tx `proveFieldPredicate`). The server supplies the field value plus its Merkle inclusion path against the anchored content root; the wallet generates the ZK proof locally and submits it. On-chain lands only "field X of this passport satisfies <= / >= threshold". The value itself never leaves the producer, and because the proof is bound to the anchored root, a made-up value cannot be substituted. A predicate that does not hold is rejected in-circuit: no transaction lands, and the cockpit records a failed proof.
7. **Revoke** (tx `revokeDisclosure(payloadHash, grantee)`). Withdrawing access is as sovereign as granting it: one wallet transaction, effective immediately, visible in the log.
8. **Share and export** (no new tx kind). The Share dialog produces the resolve link (`/resolve/<payloadHash>`) and QR code, optionally granting the supplier in the same step. The Catena-X tab exports the aspect JSON and builds the PAC, carrying the proven predicates as verifiable claims with `valueDisclosed: false`.

| Step | Circuit | Public on-chain | Stays private |
|---|---|---|---|
| Attest | `attest` / `bindPassport` / `anchorContentRoot` | payload hash, id binding, field Merkle root | the entire passport content |
| Grant / Revoke | `grantDisclosure` / `revokeDisclosure` | grantee + level per passport | the business relationship behind it |
| Prove | `proveFieldPredicate` | "field satisfies threshold", bound to the anchored root | the actual value |

Create and Register partner produce no transactions by design: data custody stays off-chain, only sovereignty moves on-chain.

## After the anchor: the passport keeps living

The first anchor is the beginning, not the end. The post-market steps follow
the same guiding rule; the re-anchoring policy decides which changes cost a
transaction.

9. **Telemetry updates** (no tx, deliberately). The BMS pushes SoH values over
   a signed webhook (`POST /api/v1/passport/telemetry`); each value is
   versioned in the attribute history, the recycler tier sees the new numbers
   immediately, and the DPP Life Cycle API can answer "what was the state at
   date X". The content now drifts from the anchored hash on purpose; the
   cockpit shows the drift.
10. **Re-anchor** (one batched transaction, same three circuits as the
    anchor). Recomputes the payload hash from the current database state,
    archives the previous anchor as a version (with its encrypted payload),
    anchors the new hash and re-binds the passport id. Superseded versions
    stay verifiable forever: the vault never forgets an attested hash, and
    the explorer's anchor history verifies each version live. On-chain
    grants and ZK claims are per version; active grants are listed for
    re-granting.
11. **Battery status change** (a re-anchor with reason `status-change`).
    `original -> repurposed | reused | remanufactured -> waste`, enforced by
    a transition matrix and versioned like telemetry; the DPP document's
    `DPPStatus` mirrors it (waste reads as Archived).
12. **Operator handover** (tx `registerPassport`). For Second Life the
    registrar re-registers the passport id to the new operator's attester
    identity; on success the owner scope flips. The previous operator is
    locked out in-circuit ("not passport owner") and by the server's owner
    guard; the new operator re-anchors and re-grants from day one, even on a
    zero-funded wallet (fee-sponsored).

| Step | Circuit | Public on-chain | Stays private |
|---|---|---|---|
| Telemetry | none | nothing (accumulates as drift) | every measured value |
| Re-anchor / status change | `attest` / `bindPassport` / `anchorContentRoot` | the new version's hash + root | old and new content alike |
| Operator handover | `registerPassport` | new owner's attester id for the passport id | the commercial handover behind it |

## Reading a transaction in the explorer

Every tx link in the cockpit (Transactions / Disclosure / Predicate tabs) opens the [Midnight explorer](https://preprod.midnightexplorer.com/). Using an `attest` tx as the example, the page breaks down like this:

| Explorer field | What it means here |
|---|---|
| Status / block / timestamp | The public, immutable proof of **when** the passport was anchored. |
| Contract address | The `attestation-vault` the cockpit targets (currently `da9b0bcf…0812` on preprod). |
| Entry point (`attest`, `anchorContentRoot`, `grantDisclosure`, `proveFieldPredicate`, …) | Which circuit ran. Publicly auditable: anyone can see **that** an attestation / grant / proof happened on this contract. |
| Outputs created/spent: 0 | No tokens moved. These are pure contract-state updates (a registry write), not payments. |
| Serialized size (~8 KB for a "state-only" tx) | Mostly the zero-knowledge proof, generated locally in the wallet (the `prove -> balance -> submit` steps in the cockpit's wallet log). Nodes verify the proof, never the private inputs. |
| Fee 0.00 tDUST + Dust ledger event | Midnight fees are paid in DUST, which regenerates from held NIGHT; the event row is the fee bookkeeping. |
| Ledger parameters / identifiers (hex) | The public circuit inputs, e.g. the payload hash. Recomputable by anyone who holds the passport data; opaque bytes to anyone who does not. |

Just as important is what the page does **not** show. There is no sender address (the wallet is shielded, so the producer's identity is not publicly linked to the tx), no passport data (no carbon value, supplier, chemistry), and no cleartext call arguments (only commitments and hashes). Publicly verifiable are the *what* and *when*; the *who* and the *content* stay private. That separation is the point of anchoring on Midnight instead of a transparent chain.

## Glossary

- **PAC** (Predicate Attestation Credential): the credential NIGHTPASS introduces, a zero-knowledge predicate proof (for example "recycled share >= X%") that proves the statement without disclosing the value.
- **AAC** (Attribute Attestation Credential, AAC-SD): the Tractus-X credential profile that reveals or hides attributes via BBS+, with no predicate mode.
- **EDC** (Eclipse Dataspace Connector): the standard component for sovereign data exchange; PAC is delivered over its data plane.
- **content root**: a Merkle root over a passport's provable fields, anchored on-chain, that a field-bound predicate proof binds the proven value to.
- **anchor version**: one on-chain anchor of a passport's content. Substantive changes (status, corrections, batched telemetry) create a new version; superseded versions are archived with their payload cipher and stay independently verifiable forever.
