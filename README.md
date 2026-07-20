# NIGHTPASS - Digital Battery Passport on Midnight

![alt text](/docs/readme_header.png)

**EU Battery Regulation 2023/1542 Digital Battery Passport with three disclosure tiers, backed by zero-knowledge attestations on Midnight.**

[![Tests](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml)
[![codecov](https://codecov.io/gh/ODATANO/NIGHTPASS/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/NIGHTPASS)
[![@odatano/nightgate](https://img.shields.io/npm/v/@odatano/nightgate?logo=npm&label=%40odatano%2Fnightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E10-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preview-2b2b6f)](https://midnight.network/)
[![Midnight](https://img.shields.io/badge/Midnight-preprod-2b2b6f)](https://midnight.network/)
[![Catena-X](https://img.shields.io/badge/Catena--X-CX--0143-009f4d)](https://catena-x.net/)

**Explorer: [zkpassport.eu](https://zkpassport.eu)** a public, block-explorer-style view where anyone can inspect the anchored passports, see the proven ZK claims (values stay hidden) and verify them live against Midnight, no account needed.

**Try it yourself: [demo.zkpassport.eu](https://demo.zkpassport.eu)** an interactive live demo. Create a battery passport, prove a confidential number with zero-knowledge, and watch it anchor on Midnight in about five minutes. No account, no wallet, no funds; every fee is sponsored, and the finished passport shows up in the explorer above.

NIGHTPASS implements the EU Battery Passport. One dataset is exposed with a different view per audience (consumer, recycler, authority), and sensitive numbers (for example "recycled cobalt share is at least the legal minimum") can be **proven without revealing the value**. Only a payload hash and public metadata are anchored on-chain; everything else stays encrypted off-chain, and the disclosure tier is enforced in the API layer.

It consumes [`@odatano/nightgate`](https://github.com/ODATANO/NIGHTGATE) as a CAP plugin, which provides the contract, the ZK proof library, and the Nightgate worker for async on-chain submission.

NIGHTPASS passes the official [BatteryPass-Ready](https://batterypass-ready.gefeg.com/) test environment (GEFEG / Fraunhofer IPK, DIN DKE SPEC 99100): zero-error data validation and all 11 interoperability scenarios of the DPP Life Cycle API, including the access-rights checks, verified 2026-07-17. On top of the standard API, a NIGHTPASS extension (`GET /dpp-api/v1/dpps/{id}/verification`) lets any caller verify a served passport live against its Midnight anchor.

## How it works, in short

- **Disclosure tiers** (Annex XIII): consumer sees public metadata, recycler additionally chemistry / capacity / recycled shares, authority everything including supplier identities. Enforced server-side by `after READ` handlers; an active on-chain disclosure grant elevates a partner's tier per passport.
- **Field-bound ZK predicates**: claims like `carbon footprint <= threshold` are proven on-chain without revealing the value, bound to a Merkle root over the passport's fields anchored at attest time, so the proven value provably comes from *this* passport.
- **One contract**, `attestation-vault` (shipped by the plugin): attest, passport binding, disclosure ACL, content-root anchoring, field-bound predicates.
- **Two submit paths** to the same contract: server (NIGHTGATE worker wallet, async jobs) or wallet (the user's own Lace via DApp-Connector). Offline-first: without a session or contract, actions land as local log rows and everything still works.
- **Zero-funding onboarding (fee sponsoring)**: set `PASSPORT_FEE_SPONSOR_WALLET=<walletId>` and that server wallet pays the dust fees for every other wallet's on-chain legs (anchoring, disclosure grants, predicate proofs) via NIGHTGATE 0.8.0 per-tx sponsoring; the acting wallet builds and signs, the sponsor balances only the fee and submits. A new producer needs neither NIGHT nor dust, ever. Live proof: [`BAT-SPOND-20260718162027`](https://zkpassport.eu/p/BAT-SPOND-20260718162027) runs on delegated dust GENERATION (mechanism A), and [`BAT-SPONF-20260718183121`](https://zkpassport.eu/p/BAT-SPONF-20260718183121) was anchored by a wallet that never held NIGHT or dust at all, every fee paid per-tx by the platform wallet (attest [`9b3bcc5a...2f2aa0f3`](https://preview.midnightexplorer.com/transactions/0x9b3bcc5a2ed1670bc4fbeda8c05ddc09e4bd36385e6cfcfbf4d7c4732f2aa0f3)).
- **Catena-X**: the cockpit exports the CX-0143 battery-passport aspect JSON and a **Predicate Attestation Credential (PAC)**, carrying the proven predicates with `valueDisclosed: false`. That predicate capability is what Tractus-X currently lacks.

### Live example (Midnight preview)

One passport, end to end: `BAT-FRESH-20260717125619`, created through the standard producer flow (all 65 guide attributes seeded automatically and included in the anchored payload hash), zero-error validated by the official BatteryPass-Ready test environment, then server-signed, anchored and predicate-proven on Midnight preview on 2026-07-17. `verifyOnChain` confirms the anchor live against the indexer. The proof transactions prove each claim against the passport's anchored content root; the value enters only as a private witness, and the ledger accepts the transaction only if the in-circuit asserts hold, so an included tx IS the verified proof.

| Step | Transaction |
|---|---|
| attest (payload hash into the vault) | [`6071a396...248673b8`](https://preview.midnightexplorer.com/transactions/0x6071a39608d172d3a7a3b34593263992e7621f7d9e7250e533d1f1fd248673b8) |
| bindPassport (passport id -> payload hash) | [`374c61d9...e0df2cb4`](https://preview.midnightexplorer.com/transactions/0x374c61d9777a67f2e1e8d9a05a39ef394989e6671c4cc8a64fc35d23e0df2cb4) |
| anchorContentRoot (Merkle root over provable fields) | [`f7f10047...6512a0aa`](https://preview.midnightexplorer.com/transactions/0xf7f10047e248b726ec7c22b36efe4086fe7ccece068978fd72f8132a6512a0aa) |
| prove: carbon footprint <= 4000 kg CO2e (value hidden) | [`771e6b7f...171581e2`](https://preview.midnightexplorer.com/transactions/0x771e6b7fdcacc8638f9aefa27b8d919ed80793a4a4f7156466d353f7171581e2) |
| prove: recycled cobalt share >= 16 % (value hidden) | [`f632a4fc...9bdda074`](https://preview.midnightexplorer.com/transactions/0xf632a4fc6e336c576924ff618fab00d95aa6d154601d1149dde9af9e9bdda074) |
| prove: usable capacity >= 70 kWh (value hidden) | [`33cffbeb...41dfa669`](https://preview.midnightexplorer.com/transactions/0x33cffbeb5ebfdc97fcaf4d26e6693db3399a9991e45e26cf216248c441dfa669) |

Vault contract: `f7c755235cc9408bc6664f7cae88b445798726ccdf9a6a560e7c873c807aabe1`.

## Documentation

| Doc | Contents |
|---|---|
| [docs/producer-flow.md](docs/producer-flow.md) | Step-by-step lifecycle: which steps produce transactions and why, how to read them in the explorer, live Preview transactions, glossary |
| [docs/producer-walkthrough.md](docs/producer-walkthrough.md) | Producer cockpit with screenshots, tab by tab |
| [docs/architecture.md](docs/architecture.md) | Layers, data flow, security model, field-bound proof construction, plugin build & deploy |

## Quick start

Requires Node.js >= 22

```bash
npm install            # postinstall generates @cds-models and builds the connector lib
cp .env.example .env   # set ENCRYPTION_KEY (.env is gitignored)
npm run deploy         # creates db/passport.db: domain tables + the midnight_* plugin tables
npm start              # cds-tsx serve  ->  http://localhost:4004
```

Open http://localhost:4004/ for the launchpad.

### Apps and services on :4004

| Surface | Path |
|---|---|
| Producer cockpit (create, attest, disclose, prove; in-app Lace wallet flow) | `/producer/webapp/index.html` |
| Consumer passport viewer (3 tiers) | `/passport/webapp/` |
| Passport Explorer (public, block-explorer style, live verification) | `/explorer/` |
| MockSapService (goods-receipt feed) | `/api/v1/mock-sap` |
| ProducerService | `/api/v1/producer` |
| PassportService | `/api/v1/passport` |
| NightgateService (+ indexer / analytics / admin) | `/api/v1/nightgate` |

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Serve via `cds-tsx serve` |
| `npm run deploy` | Deploy the merged model to `db/passport.db` |
| `npm run build:connector-lib` | Build the connector into `app/connector/lib` (self-contained ESM, WASM inlined) |
| `npm run producer:smoke` | Producer cockpit offline-path smoke test |
| `npm run pac:demo` | Build a PAC and verify it (`tractusx/pac/`) |
