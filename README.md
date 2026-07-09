# NIGHTPASS - Digital Battery Passport on Midnight

![alt text](/docs/readme_header.png)

**EU Battery Regulation 2023/1542 Digital Battery Passport with three disclosure tiers, backed by zero-knowledge attestations on Midnight.**

[![Tests](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml)
[![codecov](https://codecov.io/gh/ODATANO/NIGHTPASS/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/NIGHTPASS)
[![@odatano/nightgate](https://img.shields.io/npm/v/@odatano/nightgate?logo=npm&label=%40odatano%2Fnightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E9-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preview-2b2b6f)](https://midnight.network/)
[![Catena-X](https://img.shields.io/badge/Catena--X-CX--0143-009f4d)](https://catena-x.net/)

NIGHTPASS implements the EU Battery Passport. One dataset is exposed with a different view per audience (consumer, recycler, authority), and sensitive numbers (for example "recycled cobalt share is at least the legal minimum") can be **proven without revealing the value**. Only a payload hash and public metadata are anchored on-chain; everything else stays encrypted off-chain, and the disclosure tier is enforced in the API layer.

It consumes [`@odatano/nightgate`](https://github.com/ODATANO/NIGHTGATE) as a CAP plugin (`cds.requires.nightgate`).

## How it works, in short

- **Disclosure tiers** (Annex XIII): consumer sees public metadata, recycler additionally chemistry / capacity / recycled shares, authority everything including supplier identities. Enforced server-side by `after READ` handlers; an active on-chain disclosure grant elevates a partner's tier per passport.
- **Field-bound ZK predicates**: claims like `carbon footprint <= threshold` are proven on-chain without revealing the value, bound to a Merkle root over the passport's fields anchored at attest time, so the proven value provably comes from *this* passport.
- **One contract**, `attestation-vault` (shipped by the plugin): attest, passport binding, disclosure ACL, content-root anchoring, field-bound predicates.
- **Two submit paths** to the same contract: server (NIGHTGATE worker wallet, async jobs) or wallet (the user's own Lace via DApp-Connector). Offline-first: without a session or contract, actions land as local log rows and everything still works.
- **Catena-X**: the cockpit exports the CX-0143 battery-passport aspect JSON and a **Predicate Attestation Credential (PAC)**, carrying the proven predicates with `valueDisclosed: false`. That predicate capability is what Tractus-X currently lacks.

## Documentation

| Doc | Contents |
|---|---|
| [docs/producer-flow.md](docs/producer-flow.md) | Step-by-step lifecycle: which steps produce transactions and why, how to read them in the explorer, live Preview transactions, glossary |
| [docs/producer-walkthrough.md](docs/producer-walkthrough.md) | Producer cockpit with screenshots, tab by tab |
| [docs/architecture.md](docs/architecture.md) | Layers, data flow, security model, field-bound proof construction, plugin build & deploy |

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
| Producer cockpit (create, attest, disclose, prove; in-app Lace wallet flow) | `/producer/webapp/index.html` |
| Consumer passport viewer (3 tiers) | `/passport/webapp/` |
| MockSapService (goods-receipt feed) | `/api/v1/mock-sap` |
| ProducerService | `/api/v1/producer` |
| PassportService | `/api/v1/passport` |
| NightgateService (+ indexer / analytics / admin) | `/api/v1/nightgate` |

### Login (custom auth, `srv/auth.js`)

Anonymous resolves to consumer. Built-in demo users: `producer`/`producer`, `recycler`/`recycler`, `authority`/`authority`. Dataspace partners log in with their BPN plus secret (from `passport.Partners`) and see only passports granted to them, at the granted level.

## Repository layout

```
db/passport-schema.cds            Passports / Batteries / RecycledMaterials / DiligenceDoc + tracking tables
db/mock-sap-schema.cds            mock SAP goods-receipt feed (GoodsReceipts)
db/data/passport-*.csv            CSV seeds (partners, batteries, recycled materials, grantee identities)
srv/passport-service.{cds,ts}     consumer read side: tier gating, QR resolve, credential export
srv/producer-service.{cds,ts}     producer cockpit write side: create, submit, disclose, prove
srv/mock-sap-service.{cds,ts}     mock SAP goods-receipt source (triggerGoodsReceipt feeds generatePassport)
srv/lib/goods-receipt.ts          deterministic goods-receipt generator + row/batch mapping
srv/lib/passport-anchor.ts        canonical hashing, encryption, anchor sequence, content-root Merkle builder
srv/lib/chain-verify.ts           structural on-chain verification of wallet-reported tx hashes
srv/auth.js                       custom CAP auth (demo users + BPN partners)
app/producer/webapp/              producer cockpit (SAPUI5), in-app Lace wallet flow
app/passport/webapp/              consumer viewer, one app / three tiers
app/connector/                    in-app Lace connector library (connector.mjs, Vite lib bundle)
tractusx/pac/                     Predicate Attestation Credential glue + verify demo
docs/                             producer-flow.md, producer-walkthrough.md, architecture.md/svg/png
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Serve via `cds-tsx serve` |
| `npm run deploy` | Deploy the merged model to `db/passport.db` |
| `npm run build:connector-lib` | Build the connector into `app/connector/lib` (self-contained ESM, WASM inlined) |
| `npm run producer:smoke` | Producer cockpit offline-path smoke test |
| `npm run pac:demo` | Build a PAC and verify it (`tractusx/pac/`) |
