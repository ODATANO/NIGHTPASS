# @odatano/passport (NIGHTPASS)

**EU Battery Regulation 2023/1542 Digital Product Passport with three disclosure tiers, backed by zero-knowledge attestations on Midnight.**

[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E9-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preview-2b2b6f)](https://midnight.network/)
[![NIGHTGATE](https://img.shields.io/badge/plugin-%40odatano%2Fnightgate%200.4.3-6f42c1)](https://github.com/ODATANO/NIGHTGATE)
[![Catena-X](https://img.shields.io/badge/Catena--X-CX--0143-009f4d)](https://catena-x.net/)

NIGHTPASS implements the EU Battery Passport. One dataset is exposed with a different view per audience (consumer, recycler, authority), and sensitive numbers (for example "recycled cobalt share is at least the legal minimum") can be **proven without revealing the value**. Only a payload hash and public metadata are anchored on-chain; everything else stays encrypted off-chain, and the disclosure tier is enforced in the API layer.

It consumes [`@odatano/nightgate`](https://github.com/ODATANO/NIGHTGATE) as a CAP plugin (`cds.requires.nightgate`).

## Disclosure tiers

The regulation puts conflicting disclosure rules on one dataset, so a single passport answers different audiences with different views:

| Tier | Audience | Annex XIII scope |
|---|---|---|
| consumer | public / phone scan | Point 1 public metadata + QR |
| recycler | legitimate-interest parties | + cell chemistry, capacity, recycled-material shares (Points 2/3) |
| authority | regulators | + supplier identities, carbon footprint, due-diligence docs, on-chain lineage |

The tier is enforced server-side by `after READ` handlers in `srv/passport-service.ts` that redact restricted fields. An active on-chain disclosure grant elevates a requester's tier above their login role, scoped per passport (by `payloadHash`), and degrades to the login role on any lookup failure.

## Field-bound zero-knowledge predicates

Some claims must be provable without disclosing the value, which reveal-or-hide credentials cannot express. NIGHTPASS proves them and binds the proven value to the passport's actual field, so a verifier knows the value came from **this** passport and not an arbitrary number.

How it works:

1. At attest time the producer anchors a **content root**: a Merkle tree over the passport's provable fields, each leaf `persistentHash(fieldKey, scaledValue)`. The off-chain tree is built with the contract's exported `pureCircuits`, so it hashes identically to the circuit.
2. To prove a claim, `proveFieldPredicate(payloadHash, fieldKey, threshold, op)` recomputes the field's Merkle leaf from witnessed value plus inclusion path, folds it to a root, asserts that root equals the anchored `content_root`, then asserts the predicate (`value <= threshold` or `value >= threshold`).
3. The transaction only lands if both asserts hold, so a successful tx is the proof. The value stays a witness and never goes on-chain.

Provable fields (all commercially sensitive, all with a regulatory or buyer-relevant bound):

| Field | Example bound |
|---|---|
| carbon footprint (kg CO2/kWh) | value <= class threshold |
| capacity (kWh) | value >= rated |
| recycled content % | value >= Art. 8 minimum |
| cycle life (cycles) | value >= floor |
| round-trip efficiency % | value >= floor |
| lead content (ppm) | value <= limit |
| recycled cobalt / lithium / nickel % | value >= Art. 8 minimum (per material) |

The off-chain Merkle builder lives in `srv/lib/passport-anchor.ts` (`buildContentRoot`, `PROVABLE_FIELDS`); the circuits live in the plugin's `attestation-vault` contract.

## Quick start

```bash
npm install
cp .env.example .env   # set ENCRYPTION_KEY (.env is gitignored)
npm run deploy         # creates db/passport.db: domain tables + the midnight_* plugin tables
npm start              # cds-tsx serve  ->  http://localhost:4004
```

Open http://localhost:4004/ for the launchpad.

### Apps and services on :4004

| Surface | Path |
|---|---|
| Producer cockpit (create, attest, disclose, prove) | `/producer/webapp/index.html` |
| Consumer passport viewer (3 tiers) | `/passport/webapp/` |
| Wallet connector (deploy, attest, prove via Lace) | `/connector/` |
| ProducerService | `/api/v1/producer` |
| PassportService | `/api/v1/passport` |
| NightgateService (+ indexer / analytics / admin) | `/api/v1/nightgate` |

Step-by-step producer flow with screenshots: [docs/producer-walkthrough.md](docs/producer-walkthrough.md).

### Login (custom auth, `srv/auth.js`)

Anonymous resolves to consumer. Built-in demo users: `producer`/`producer`, `recycler`/`recycler`, `authority`/`authority`. Dataspace partners log in with their BPN plus secret (from `passport.Partners`) and see only passports granted to them, at the granted level. BPNs are used instead of DIDs because the colon in `did:web:...` breaks HTTP Basic auth.

## Two ways to submit on-chain

Both target the same `attestation-vault` contract on the same chain. They differ only in who holds the key.

- **Server path** (background, no wallet popups): `ProducerService` actions run through NIGHTGATE's worker wallet as async jobs. Needs a signing session (`PRODUCER_VIEWING_KEY` plus `PRODUCER_WALLET_MNEMONIC` or `PRODUCER_WALLET_SEED_HEX`) and `PASSPORT_CONTRACT_ADDRESS`. Without them, actions land as offline log rows.
- **Wallet path** (in-app, interactive): the producer cockpit and the connector page drive the same operations from the user's own Lace wallet over the DApp-Connector, using NIGHTGATE's `@odatano/nightgate/browser` building blocks. The connector code is bundled to a self-contained lib via `npm run build:connector-lib`.

The cockpit's Wallet / Server toggle selects the mode per passport; the [producer walkthrough](docs/producer-walkthrough.md) covers the step-by-step flow with screenshots.

Offline-first everywhere: without a session or contract, actions write local tracking rows (`PassportTransactions`, `DisclosureGrantLog`, `PredicateProofLog`) so the cockpit and the read gate work without the chain.

## Contract (Compact / Midnight)

There is one contract, `attestation-vault`, shipped by the plugin and registered under `cds.requires.nightgate.contracts`. It carries the tiered-disclosure ACL (`attest`, `grantDisclosure`, `revokeDisclosure`), the passport binding (`bindPassport`: `passportId -> payloadHash`), the numeric-commitment predicate (`commitValue`, `provePredicate`), and the field-bound predicate (`anchorContentRoot`, `proveFieldPredicate`) plus the exported pure hashes `leafHash` / `nodeHash`. Compact cannot inherit ledger state across contracts, so everything lives in this one contract (the former separate `passport-attestation` was folded in).

Source and managed artifacts ship in `@odatano/nightgate`; recompiling needs the Compact toolchain in WSL (compactc 0.31.0).

### Live verification (Preview)

Full round-trip proven live on the Midnight Preview network via Lace, all transactions from a funded wallet:

| Step | On-chain result |
|---|---|
| Deploy `attestation-vault` | contract [`0x93f0c359…6109b1`](https://preview.midnightexplorer.com/contracts/0x93f0c359aaaaedcf213f0945003e985f0045c12b8c46cba6d620ec6f9f6109b1) · tx [`0x577b94c2…f02b2e`](https://preview.midnightexplorer.com/transactions/0x577b94c221f3ecc00014be56c5bc298871a88d80fa3a0419faf467c76ef02b2e) (block 1425388) |
| `attest` | tx [`0x4775a800…f9bdd`](https://preview.midnightexplorer.com/transactions/0x4775a800ab048228e3b9b44a6f94b292a38b5067048f20d84eb305c9b51f9bdd) (block 1425593) |
| `anchorContentRoot` | tx [`0x8cea99f5…b6591`](https://preview.midnightexplorer.com/transactions/0x8cea99f5611de5b8dd65848c840772278c2a104a089cb48eae2e084aa11b6591) (block 1425602) |
| `proveFieldPredicate` (carbon <= threshold) | tx [`0x7e405996…6b2278`](https://preview.midnightexplorer.com/transactions/0x7e4059961cb78b0c4aab8aacb8b047789f79d8ec112117a422e8da21346b2278) (block 1425633) |

Runtime notes: the network follows the wallet (Lace `getConfiguration()` supplies the indexer and network id; `NETWORK` in `connector.mjs` is `preview`). Prove runs against a local proof server at `http://localhost:6300` because the hosted one omits the CORS header on the POST response. `submitTx` returns the transaction identifier (not the serialized tx), derived via `ledger.Transaction.deserialize(...).identifiers()[0]`.

## Catena-X / Tractus-X

The Battery Passport is Catena-X use case CX-0143. Tractus-X has no predicate or range-proof capability (its closest, AAC-SD, only reveals or hides attributes via BBS+). NIGHTPASS fills that gap with a **Predicate Attestation Credential (PAC)**: the `zkPredicate` mode that proves `value <= threshold` without revealing the value. Verification is indexer-trust: a consumer confirms the proof transaction was included and succeeded (a successful tx is the proof). The PAC glue lives in `tractusx/`; the ZK primitive lives in the plugin.

The producer cockpit surfaces this on a Catena-X tab: Generate JSON (aspect via `passportAspectJson`) and Build PAC (W3C-VC / CX-0143 via `passportCredential`, `valueDisclosed: false`). See the [producer walkthrough](docs/producer-walkthrough.md).

## Repository layout

```
db/passport-schema.cds            Passports / Batteries / RecycledMaterials / DiligenceDoc + tracking tables
db/data/passport-*.csv            CSV seeds (partners, batteries, recycled materials, grantee identities)
srv/passport-service.{cds,ts}     consumer read side: tier gating, QR resolve, credential export
srv/producer-service.{cds,ts}     producer cockpit write side: create, submit, disclose, prove
srv/lib/passport-anchor.ts        canonical hashing, encryption, anchor sequence, content-root Merkle builder
srv/auth.js                       custom CAP auth (demo users + BPN partners)
app/producer/webapp/              producer cockpit (SAPUI5)
app/passport/webapp/              consumer viewer, one app / three tiers
app/connector/                    Lace DApp-Connector page + connector.mjs (Vite lib bundle)
tractusx/pac/                     Predicate Attestation Credential glue + verify demo
docs/                             architecture.md/svg/png
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Serve via `cds-tsx serve` |
| `npm run deploy` | Deploy the merged model to `db/passport.db` |
| `npm run build:connector-lib` | Build the connector into `app/connector/lib` (self-contained ESM, WASM inlined) |
| `npm run producer:smoke` | Producer cockpit offline-path smoke test |
| `npm run pac:demo` | Build a PAC and verify it (`tractusx/pac/`) |

## Glossary

- **PAC** (Predicate Attestation Credential): the credential NIGHTPASS introduces, a zero-knowledge predicate proof (for example "recycled share >= X%") that proves the statement without disclosing the value.
- **AAC** (Attribute Attestation Credential, AAC-SD): the Tractus-X credential profile that reveals or hides attributes via BBS+, with no predicate mode.
- **EDC** (Eclipse Dataspace Connector): the standard component for sovereign data exchange; PAC is delivered over its data plane.
- **content root**: a Merkle root over a passport's provable fields, anchored on-chain, that a field-bound predicate proof binds the proven value to.
