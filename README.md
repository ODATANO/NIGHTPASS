# NIGHTPASS - Digital Battery Passport on Midnight

![alt text](/docs/readme_header.png)

[![Tests](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml)
[![codecov](https://codecov.io/gh/ODATANO/NIGHTPASS/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/NIGHTPASS)
[![@odatano/nightgate](https://img.shields.io/npm/v/@odatano/nightgate?logo=npm&label=%40odatano%2Fnightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E10-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preprod-2b2b6f)](https://midnight.network/)

**The battery passport that proves without revealing.**
NIGHTPASS implements the EU Battery Regulation 2023/1542 Digital Battery Passport, mandatory from 18 February 2027. One dataset is exposed with a different view per audience (consumer, recycler, authority), and sensitive numbers (for example "recycled cobalt share is at least the legal minimum") can be **proven without revealing the value**. Only a payload hash and public metadata are anchored on Midnight; everything else stays encrypted off-chain, and the disclosure tier is enforced in the API layer. Integrates with any ERP solution, fully SAP-compatible by design.

## How it works

- **Three disclosure tiers** (Annex XIII): one dataset, server-enforced views for consumer, recycler and authority. An on-chain grant raises a partner's tier per passport.
- **Zero-knowledge proofs**: prove `carbon footprint <= threshold` without revealing the value, cryptographically bound to *this* passport's anchored fields. Batchable: prove up to 8 field values in ONE transaction (proof cart in the cockpit, one wallet approval; or a single server call).
- **Only hashes on-chain**: the `attestation-vault` contract holds hashes, ownership, disclosure grants and proofs. The passport data itself never leaves your infrastructure.
- **One transaction per anchor**: attest, id binding and content root land in a single batched tx.
- **No crypto needed**: a fee-sponsor pool pays all fees, producers hold zero tokens, and passport ids are pre-registered on-chain so nobody can squat them.
- **The passport lives**: telemetry streams into versioned attributes (the DPP API answers "state at date X"); substantive changes re-anchor as a new version, and every old version stays verifiable forever.
- **Second Life**: hand the passport to a new operator on-chain; the old one is locked out, the new one updates from day one.
- **Straight out of SAP**: a goods receipt posted in S/4HANA mints the passport with no manual step; a small bridge polls the standard Material Documents API, pulls weight and description from the live product master and anchors automatically. Proven against SAP's public API sandbox ([example passport](https://zkpassport.eu/p/BAT-MZRMC90001-50001739511)); see [docs/s4-mapping.md](docs/s4-mapping.md).
- **Sign your way**: server wallets or the user's own Lace wallet; offline-first without either.
- **Independently conformant**: EU DPP Registry enrolled (verified economic operator, first passport registration submitted) · 11/11 official DPP API interoperability scenarios · 0 validation errors against all five official BatteryPass validation guides.
- **Evidence on file**: due-diligence documents stay off-chain; only their sha256 is anchored, so anyone can verify they are untampered.
- **Zero-infrastructure proving**: ZK proofs run in-process; local dev and CI need no proof server.
- **Catena-X**: CX-0143 aspect export plus a **Predicate Attestation Credential (PAC)** with `valueDisclosed: false`, the predicate capability Tractus-X currently lacks.

## Public demo and explorer (Midnight preprod)

**Try it yourself: [demo.zkpassport.eu](https://demo.zkpassport.eu)** an interactive live demo on Midnight preprod. Create a simple battery passport, get its id registered to your (generated, forever-empty) wallet on-chain, watch the whole anchor land as ONE batched transaction, and prove a confidential number with zero-knowledge, all in about five minutes.

**Explorer: [zkpassport.eu](https://zkpassport.eu)** a public, block-explorer-style view (Midnight preprod) where anyone can inspect the anchored passports, see the proven ZK claims (values stay hidden) and verify them live against Midnight, no account needed. Every passport finished on the demo below shows up here automatically.

## Example live demo flow

Every Demo run produces exactly three on-chain transactions. [BAT-TRY-20260724205823-7A26](https://zkpassport.eu/p/BAT-TRY-20260724205823-7A26) was anchored 2026-07-24 by an anonymous PUBLIC visitor flow: a zero-funded generated wallet, every fee sponsored, finished in 4.1 minutes and independently verified on the public explorer:

| Step | Transaction |
|---|---|
| registerPassport (registrar assigns the id to the visitor's attester identity) | [`83cc57ae...b22b9b7b`](https://preprod.midnightexplorer.com/transactions/0x83cc57aea9e77a86245be38955c6881fb143c907b904141d992c93bbb22b9b7b) |
| attest + bindPassport + anchorContentRoot, ONE batched transaction | [`9246872d...e74517f6`](https://preprod.midnightexplorer.com/transactions/0x9246872d5158a497ac72860bdddac5999be8a0ee10b5e6a3c043d65de74517f6) |
| prove: carbon footprint <= 4000 kg CO2e (value hidden) | [`a30968d6...3ba0647e`](https://preprod.midnightexplorer.com/transactions/0xa30968d63339a92240fd818de2fa56562412d9477dacb242c84bd40a3ba0647e) |

**See a full battery life:** [BAT-REANCHOR-20260730060519](https://zkpassport.eu/p/BAT-REANCHOR-20260730060519) lived the whole story on preprod: born and anchored with a ZK carbon claim (v1), aged through telemetry and re-anchored (v2), repurposed (v3), handed over to a new operator on-chain ([registerPassport](https://preprod.midnightexplorer.com/transactions/0x18bed73bd3b4f31047ac182c7a4af0ee789c177ce69eb7001f4602df628fe13f)) who ended it as waste (v4). All four anchor versions and the claim verify live on the explorer's anchor history.

## Documentation

| Doc | Contents |
|---|---|
| [docs/producer-flow.md](docs/producer-flow.md) | Step-by-step lifecycle from creation to Second Life: which steps produce transactions and why, re-anchoring and handover, how to read transactions in the explorer, glossary |
| [docs/producer-walkthrough.md](docs/producer-walkthrough.md) | Producer cockpit with screenshots, tab by tab |
| [docs/architecture.md](docs/architecture.md) | Layers, data flow, security model, field-bound proof construction, plugin build & deploy |
| [docs/s4-mapping.md](docs/s4-mapping.md) | S/4HANA integration: the goods-receipt bridge, field-by-field Annex XIII mapping, and the sandbox / S/4 Cloud / Event Mesh lanes |
| [docs/PITCHDECK.pdf](docs/PITCHDECK.pdf) | Pitch deck: problem, market, solution, architecture, traction, go-to-market |
| [docs/one-pager.md](docs/one-pager.md) | One-pager: problem, product, live proof points, data room |

## Quick start full local dev environment

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
| BmsSimulatorService (simulated BMS telemetry) | `/api/v1/bms-sim` |
| ProducerService | `/api/v1/producer` |
| PassportService | `/api/v1/passport` |
| NightgateService (+ indexer / analytics / admin) | `/api/v1/nightgate` |

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Serve via `cds-tsx serve` |
| `npm run deploy` | Deploy/evolve the merged model in the database selected by the active CAP profile |
| `npm run test:postgres` | Deploy the full model to the bound PostgreSQL database and query core NIGHTPASS/NIGHTGATE entities |
| `npm run build:connector-lib` | Build the connector into `app/connector/lib` (self-contained ESM, WASM inlined) |
| `npm run producer:smoke` | Producer cockpit offline-path smoke test |
| `npm run pac:demo` | Build a PAC and verify it (`tractusx/pac/`) |
