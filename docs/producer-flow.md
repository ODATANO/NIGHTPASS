# Producer flow: steps and transactions

The end-to-end lifecycle of one passport, which steps produce an on-chain transaction, and how to read those transactions in the explorer. The guiding rule: **passport data never goes on-chain**; the chain only ever holds hashes, entitlements, and proofs.

For cockpit screenshots per step see the [producer walkthrough](producer-walkthrough.md); for the security model and the field-bound proof construction see the [architecture](architecture.md).

## The flow, step by step

1. **Connect wallet** (no tx). The cockpit reads the shielded address from Lace; that address *is* the producer identity and scopes the passport list to the owner. No login, no central user store: holding the key is holding the identity.
2. **Create passport** (no tx, deliberately). `createPassport` canonicalizes the Annex XIII payload, computes the blake2b-256 `payloadHash`, encrypts the payload with AES-256-GCM (HKDF key per passport), and stores an off-chain draft. Creating data is ERP territory; anchoring it is a separate, wallet-signed decision.
3. **Attest** (transactions). One flow anchors three things on the `attestation-vault`: `attest` locks the `payloadHash` under the attester identity (from now on any change to the payload is detectable), `bindPassport` binds `passportId -> payloadHash` for QR resolution, and `anchorContentRoot` anchors a Merkle root over the provable fields, which every later field-bound proof binds to. Only after this does the cockpit enable Grant / Revoke / Prove / Share.
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

## Reading a transaction in the explorer

Every tx link in the cockpit (Transactions / Disclosure / Predicate tabs) opens the [Midnight explorer](https://preview.midnightexplorer.com/). Using an `attest` tx as the example, the page breaks down like this:

| Explorer field | What it means here |
|---|---|
| Status / block / timestamp | The public, immutable proof of **when** the passport was anchored. |
| Contract address | The `attestation-vault` the cockpit targets (`0x93f0c359…6109b1`). |
| Entry point (`attest`, `anchorContentRoot`, `grantDisclosure`, `proveFieldPredicate`, …) | Which circuit ran. Publicly auditable: anyone can see **that** an attestation / grant / proof happened on this contract. |
| Outputs created/spent: 0 | No tokens moved. These are pure contract-state updates (a registry write), not payments. |
| Serialized size (~8 KB for a "state-only" tx) | Mostly the zero-knowledge proof, generated locally in the wallet (the `prove -> balance -> submit` steps in the cockpit's wallet log). Nodes verify the proof, never the private inputs. |
| Fee 0.00 tDUST + Dust ledger event | Midnight fees are paid in DUST, which regenerates from held NIGHT; the event row is the fee bookkeeping. |
| Ledger parameters / identifiers (hex) | The public circuit inputs, e.g. the payload hash. Recomputable by anyone who holds the passport data; opaque bytes to anyone who does not. |

Just as important is what the page does **not** show. There is no sender address (the wallet is shielded, so the producer's identity is not publicly linked to the tx), no passport data (no carbon value, supplier, chemistry), and no cleartext call arguments (only commitments and hashes). Publicly verifiable are the *what* and *when*; the *who* and the *content* stay private. That separation is the point of anchoring on Midnight instead of a transparent chain.

## Live verification (Preview)

Full round-trip proven live on the Midnight Preview network via Lace, all transactions from a funded wallet:

| Step | On-chain result |
|---|---|
| Deploy `attestation-vault` | contract [`0x93f0c359…6109b1`](https://preview.midnightexplorer.com/contracts/0x93f0c359aaaaedcf213f0945003e985f0045c12b8c46cba6d620ec6f9f6109b1) · tx [`0x577b94c2…f02b2e`](https://preview.midnightexplorer.com/transactions/0x577b94c221f3ecc00014be56c5bc298871a88d80fa3a0419faf467c76ef02b2e) (block 1425388) |
| `attest` | tx [`0x4775a800…f9bdd`](https://preview.midnightexplorer.com/transactions/0x4775a800ab048228e3b9b44a6f94b292a38b5067048f20d84eb305c9b51f9bdd) (block 1425593) |
| `anchorContentRoot` | tx [`0x8cea99f5…b6591`](https://preview.midnightexplorer.com/transactions/0x8cea99f5611de5b8dd65848c840772278c2a104a089cb48eae2e084aa11b6591) (block 1425602) |
| `proveFieldPredicate` (carbon <= threshold) | tx [`0x7e405996…6b2278`](https://preview.midnightexplorer.com/transactions/0x7e4059961cb78b0c4aab8aacb8b047789f79d8ec112117a422e8da21346b2278) (block 1425633) |

Runtime notes: the network follows the wallet (Lace `getConfiguration()` supplies the indexer and network id; `NETWORK` in `connector.mjs` is `preview`). Prove runs against a local proof server at `http://localhost:6300` because the hosted one omits the CORS header on the POST response. `submitTx` returns the transaction identifier (not the serialized tx), derived via `ledger.Transaction.deserialize(...).identifiers()[0]`.

## Glossary

- **PAC** (Predicate Attestation Credential): the credential NIGHTPASS introduces, a zero-knowledge predicate proof (for example "recycled share >= X%") that proves the statement without disclosing the value.
- **AAC** (Attribute Attestation Credential, AAC-SD): the Tractus-X credential profile that reveals or hides attributes via BBS+, with no predicate mode.
- **EDC** (Eclipse Dataspace Connector): the standard component for sovereign data exchange; PAC is delivered over its data plane.
- **content root**: a Merkle root over a passport's provable fields, anchored on-chain, that a field-bound predicate proof binds the proven value to.
