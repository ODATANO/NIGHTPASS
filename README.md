# NIGHTPASS - Digital Battery Passport on Midnight

![alt text](/docs/readme_header.png)

**EU Battery Regulation 2023/1542 Digital Battery Passport with three disclosure tiers, backed by zero-knowledge attestations on Midnight.**

[![Tests](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml)
[![codecov](https://codecov.io/gh/ODATANO/NIGHTPASS/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/NIGHTPASS)
[![@odatano/nightgate](https://img.shields.io/npm/v/@odatano/nightgate?logo=npm&label=%40odatano%2Fnightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E9-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preview-2b2b6f)](https://midnight.network/)
[![Midnight](https://img.shields.io/badge/Midnight-preprod-2b2b6f)](https://midnight.network/)
[![Catena-X](https://img.shields.io/badge/Catena--X-CX--0143-009f4d)](https://catena-x.net/)

NIGHTPASS implements the EU Battery Passport. One dataset is exposed with a different view per audience (consumer, recycler, authority), and sensitive numbers (for example "recycled cobalt share is at least the legal minimum") can be **proven without revealing the value**. Only a payload hash and public metadata are anchored on-chain; everything else stays encrypted off-chain, and the disclosure tier is enforced in the API layer.

It consumes [`@odatano/nightgate`](https://github.com/ODATANO/NIGHTGATE) as a CAP plugin (`cds.requires.nightgate`).

## How it works, in short

- **Disclosure tiers** (Annex XIII): consumer sees public metadata, recycler additionally chemistry / capacity / recycled shares, authority everything including supplier identities. Enforced server-side by `after READ` handlers; an active on-chain disclosure grant elevates a partner's tier per passport.
- **Field-bound ZK predicates**: claims like `carbon footprint <= threshold` are proven on-chain without revealing the value, bound to a Merkle root over the passport's fields anchored at attest time, so the proven value provably comes from *this* passport.
- **One contract**, `attestation-vault` (shipped by the plugin): attest, passport binding, disclosure ACL, content-root anchoring, field-bound predicates.
- **Two submit paths** to the same contract: server (NIGHTGATE worker wallet, async jobs) or wallet (the user's own Lace via DApp-Connector). Offline-first: without a session or contract, actions land as local log rows and everything still works.
- **Catena-X**: the cockpit exports the CX-0143 battery-passport aspect JSON and a **Predicate Attestation Credential (PAC)**, carrying the proven predicates with `valueDisclosed: false`. That predicate capability is what Tractus-X currently lacks.

### Live example (Midnight preview, 2026-07-11)

One ERP goods-receipt ingested end-to-end (signed webhook -> `createPassport` -> auto-anchor), passport `BAT-GR-0015`, three transactions on the preview network:

| Step | Transaction |
|---|---|
| attest | [`67df45db...cc42d8e2`](https://preview.midnightexplorer.com/transactions/0x67df45db9a4c67d1b6af55cf5dbe0d874ecfe0e40ac57e80d5ad7abecc42d8e2) |
| bindPassport | [`97c36cb5...bb5991bb`](https://preview.midnightexplorer.com/transactions/0x97c36cb573ed7ce9ed2d64f45986efa4023859b478ae9a283a0484a6bb5991bb) |
| anchorContentRoot | [`6cce29ba...93020e16`](https://preview.midnightexplorer.com/transactions/0x6cce29baa9be9237782386ffda00eaebbfd1a18bf68abaf3b0ce9dab93020e16) |

Vault contract: `dcd297ba6a335a5d64916a6f2e36151c7490baa119fd022c846944918d9cde69`.

## Documentation

| Doc | Contents |
|---|---|
| [docs/producer-flow.md](docs/producer-flow.md) | Step-by-step lifecycle: which steps produce transactions and why, how to read them in the explorer, live Preview transactions, glossary |
| [docs/producer-walkthrough.md](docs/producer-walkthrough.md) | Producer cockpit with screenshots, tab by tab |
| [docs/architecture.md](docs/architecture.md) | Layers, data flow, security model, field-bound proof construction, plugin build & deploy |

## Quick start

Requires Node.js >= 22 (see `.nvmrc`).

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
