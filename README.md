# NIGHTPASS - Digital Battery Passport on Midnight

![alt text](/docs/readme_header.png)

[![Tests](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml)
[![codecov](https://codecov.io/gh/ODATANO/NIGHTPASS/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/NIGHTPASS)
[![@odatano/nightgate](https://img.shields.io/npm/v/@odatano/nightgate?logo=npm&label=%40odatano%2Fnightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E10-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preprod-2b2b6f)](https://midnight.network/)

**EU Battery Regulation 2023/1542 Digital Battery Passport with three disclosure tiers, backed by zero-knowledge attestations on Midnight.**
NIGHTPASS implements the EU Battery Passport. One dataset is exposed with a different view per audience (consumer, recycler, authority), and sensitive numbers (for example "recycled cobalt share is at least the legal minimum") can be **proven without revealing the value**. Only a payload hash and public metadata are anchored on-chain; everything else stays encrypted off-chain, and the disclosure tier is enforced in the API layer.

## How it works

- **Disclosure tiers** (Annex XIII): one dataset, three server-enforced views (consumer / recycler / authority); an on-chain disclosure grant elevates a partner's tier per passport.
- **Field-bound ZK predicates**: prove `carbon footprint <= threshold` without revealing the value, bound to the passport's anchored Merkle root, so the proven value comes from *this* passport.
- **One contract**, `attestation-vault` (shipped by the plugin): attest, passport binding, ownership registry, disclosure ACL, content root, predicates.
- **Two submit paths**: server-signed (async NIGHTGATE jobs) or the user's own Lace wallet; offline-first fallback without either.
- **Fee sponsoring**: the `PASSPORT_FEE_SPONSOR_WALLET` pool pays every other wallet's dust fees; a new producer needs neither NIGHT nor dust. Every demo visitor runs on a zero-funded wallet.
- **Single-transaction anchoring**: attest + bindPassport + anchorContentRoot ride in ONE batched transaction with deterministic apply order (NIGHTGATE >= 0.10.0), see the demo flow below.
- **On-chain passport ownership**: the registrar pre-assigns a passportId to an offline-derived attester identity before its first bind; registered ids cannot be squatted or hijacked, see the demo flow below.
- **BatteryPass-Ready conformant**: passports validate with **0 errors against all five official validation guides** (EV, LMT, stationary industrial, other industrial, industrial without BMS; guide picked by battery category) and pass **all 11 interop scenarios** of the official DPP Life Cycle API test suite.
- **Due-diligence evidence**: upload the supply-chain due-diligence report in the cockpit; the file stays off-chain (authority tier), only its sha256 is anchored on-chain, so anyone can verify the document is authentic and untampered.
- **EU DPP Registry**: the registration flow is proven against the official registry test environment (verified economic operator, UPI resolving to the public explorer); battery registrations complete once the registry's semantic validation for the product group goes live.
- **Zero-infrastructure proving**: with NIGHTGATE >= 0.11.0, ZK proofs run in-process (wasm) whenever no proof server is configured; local dev and CI need no Docker container.
- **Catena-X**: exports the CX-0143 aspect JSON plus a **Predicate Attestation Credential (PAC)** with `valueDisclosed: false`, the predicate capability Tractus-X currently lacks.

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

## Documentation

| Doc | Contents |
|---|---|
| [docs/producer-flow.md](docs/producer-flow.md) | Step-by-step lifecycle: which steps produce transactions and why, how to read them in the explorer, live transactions, glossary |
| [docs/producer-walkthrough.md](docs/producer-walkthrough.md) | Producer cockpit with screenshots, tab by tab |
| [docs/architecture.md](docs/architecture.md) | Layers, data flow, security model, field-bound proof construction, plugin build & deploy |

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
| MockSapService (goods-receipt feed) | `/api/v1/mock-sap` |
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
