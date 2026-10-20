# NIGHTPASS - Digital Product Passport on Midnight

![alt text](/docs/readme_header.png)

[![Tests](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml/badge.svg)](https://github.com/ODATANO/NIGHTPASS/actions/workflows/test.yaml)
[![codecov](https://codecov.io/gh/ODATANO/NIGHTPASS/branch/main/graph/badge.svg)](https://codecov.io/gh/ODATANO/NIGHTPASS)
[![@odatano/nightgate](https://img.shields.io/npm/v/@odatano/nightgate?logo=npm&label=%40odatano%2Fnightgate)](https://www.npmjs.com/package/@odatano/nightgate)
[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E10-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preprod-2b2b6f)](https://midnight.network/)

**The product passport that proves without revealing.**
NIGHTPASS issues Digital Product Passports on Midnight for two product families: the EU battery passport (Regulation 2023/1542, mandatory from 18 February 2027) and the component passport for safety-related parts of regulated plants. One dataset is exposed with a different view per audience (public, legitimate interest, authority), and sensitive values (for example "recycled cobalt share is at least the legal minimum" or "cobalt content is at most 200 ppm") can be **proven without revealing the value**. Only a payload hash and public metadata are anchored on Midnight; everything else stays encrypted off-chain, and the disclosure level is enforced in the API layer. Integrates with any ERP solution, fully SAP-compatible by design.

## How it works

- **Product families**: a passport belongs to a family (`battery` or `component`). The family decides which detail tables the passport fills, which fields are provable and which allow-lists its membership claims use. Both families share the same anchor, disclosure and proof mechanics.
- **Three disclosure levels**: one dataset, server-enforced views for public, legitimate-interest and authority readers. An on-chain grant raises a partner's level per passport.
- **Zero-knowledge proofs**: prove `value <= threshold`, `value >= threshold` or `value is one of a published allow-list` without revealing the value, cryptographically bound to *this* passport's anchored fields. Batchable: prove up to 8 field values in ONE transaction (proof cart in the cockpit, one wallet approval; or a single server call).
- **Only hashes on-chain**: the `attestation-vault` contract holds hashes, ownership, disclosure grants and proofs. The passport data itself never leaves your infrastructure.
- **One transaction per anchor**: attest, id binding and content root land in a single batched tx.
- **No crypto needed**: a fee-sponsor pool pays all fees, producers hold zero tokens, and passport ids are pre-registered on-chain so nobody can squat them.
- **Versioned anchors**: substantive changes re-anchor the passport as a new version, and every old version stays verifiable forever.
- **Operator handover**: hand the passport to a new operator on-chain; the old one is locked out, the new one updates from day one.
- **Sign your way**: server wallets or the user's own Lace wallet; offline-first without either.
- **Evidence stays off-chain**: due-diligence reports, material certificates and test reports are kept as files; only their sha256 is anchored or hashed into the passport payload, so anyone can verify they are untampered.
- **Zero-infrastructure proving**: ZK proofs run in-process; local dev and CI need no proof server.

## Product families

### Battery passport

The EU Battery Regulation 2023/1542 Digital Battery Passport (Annex XIII).

- **Disclosure tiers per Annex XIII**: the three levels map to consumer (Point 1 public data), recycler (Points 2/3) and authority (Points 2/3 plus supplier identities and due-diligence evidence).
- **Provable fields**: carbon footprint, usable capacity, cycle life, recycled content, round-trip efficiency, lead content; cell chemistry as a membership claim against the recognized-chemistries list.
- **The passport lives**: telemetry streams into versioned attributes (the DPP Life Cycle API answers "state at date X"); a battery status change re-anchors immediately.
- **Second Life**: age, repurpose and hand the battery to a new operator; all anchor versions stay verifiable.
- **Straight out of SAP**: a goods receipt posted in S/4HANA mints the passport with no manual step; a small bridge polls the standard Material Documents API, pulls weight and description from the live product master and anchors automatically. Proven against SAP's public API sandbox ([example passport](https://zkpassport.eu/p/BAT-MZRMC90001-50001739511)); see [docs/s4-mapping.md](docs/s4-mapping.md).
- **Independently conformant**: EU DPP Registry enrolled (verified economic operator, first passport registration submitted) · 11/11 official DPP API interoperability scenarios · 0 validation errors against all five official BatteryPass validation guides.
- **Catena-X**: CX-0143 aspect export plus a **Predicate Attestation Credential (PAC)** with `valueDisclosed: false`, the predicate capability Tractus-X currently lacks.
- The producer cockpit, the BMS simulator, the DPP Life Cycle API and the Catena-X export serve this family.

### Component passport

Safety-related engineered parts of regulated plants, for example pressure-boundary or structural components, under quality-assurance regimes such as ASME III or KTA 1401.

- **Public**: designation, manufacturer, mass, safety class, component status (manufactured, qualified, installed, in service, quarantined, retired), manufacture date and the QR landing.
- **Legitimate interest**: material certificates (heat number, material grade, yield and tensile strength, hardness, cobalt content, wall thickness, certificate hash) and qualification tests (standard, test method, result, report hash).
- **Authority only**: supplier identity and name, inspector identity, and the chain-of-custody trail (every handover of the part with its record hash).
- **Provable claims**: cobalt content at most a limit (for example 200 ppm), yield strength at least a minimum (for example 450 MPa), hardness at most a limit, wall thickness at least a minimum; membership claims that the material grade is one of the approved grades (or one of the austenitic grades), the supplier is on the qualified supplier list, and the test method is an approved NDT method.

## Public demo and explorer (Midnight preprod)

**Try it yourself: [demo.zkpassport.eu](https://demo.zkpassport.eu)** an interactive live demo on Midnight preprod. Pick a product family (battery or component), fill the family's public head fields, choose which confidential values to prove (the family's primary claim is always proven, the rest are optional and ride in ONE proof transaction), and watch each anchor step land with its transaction hash, all in about five minutes. Battery runs can add a second-life act (age, repurpose, re-anchor as version 2). Your wallet is generated for the run and stays empty forever; every fee is sponsored. The done screen hands you the passport's QR code.

**Explorer: [zkpassport.eu](https://zkpassport.eu)** a public, block-explorer-style view (Midnight preprod) where anyone can inspect the anchored passports of both families, see the proven ZK claims (values stay hidden) and verify them live against Midnight, no account needed. Every passport finished on the demo shows up here automatically.

## Example live demo flow (battery)

A demo run produces three on-chain transactions (four with the battery second-life act). [BAT-TRY-20260724205823-7A26](https://zkpassport.eu/p/BAT-TRY-20260724205823-7A26) was anchored 2026-07-24 by an anonymous PUBLIC visitor flow: a zero-funded generated wallet, every fee sponsored, finished in 4.1 minutes and independently verified on the public explorer:

| Step | Transaction |
|---|---|
| registerPassport (registrar assigns the id to the visitor's attester identity) | [`83cc57ae...b22b9b7b`](https://preprod.midnightexplorer.com/transactions/0x83cc57aea9e77a86245be38955c6881fb143c907b904141d992c93bbb22b9b7b) |
| attest + bindPassport + anchorContentRoot, ONE batched transaction | [`9246872d...e74517f6`](https://preprod.midnightexplorer.com/transactions/0x9246872d5158a497ac72860bdddac5999be8a0ee10b5e6a3c043d65de74517f6) |
| prove: carbon footprint <= 4000 kg CO2e (value hidden) | [`a30968d6...3ba0647e`](https://preprod.midnightexplorer.com/transactions/0xa30968d63339a92240fd818de2fa56562412d9477dacb242c84bd40a3ba0647e) |

**See a full battery life:** [BAT-REANCHOR-20260730060519](https://zkpassport.eu/p/BAT-REANCHOR-20260730060519) lived the whole story on preprod: born and anchored with a ZK carbon claim (v1), aged through telemetry and re-anchored (v2), repurposed (v3), handed over to a new operator on-chain ([registerPassport](https://preprod.midnightexplorer.com/transactions/0x18bed73bd3b4f31047ac182c7a4af0ee789c177ce69eb7001f4602df628fe13f)) who ended it as waste (v4). All four anchor versions and the claim verify live on the explorer's anchor history.

## Documentation

| Doc | Contents |
|---|---|
| [docs/producer-flow.md](docs/producer-flow.md) | Step-by-step battery lifecycle from creation to Second Life: which steps produce transactions and why, re-anchoring and handover, how to read transactions in the explorer, glossary |
| [docs/producer-walkthrough.md](docs/producer-walkthrough.md) | Producer cockpit (battery) with screenshots, tab by tab |
| [docs/architecture.md](docs/architecture.md) | Layers, data flow, security model, product profiles, field-bound proof construction, plugin build & deploy |
| [docs/public-demo.md](docs/public-demo.md) | Public explorer and "Try it" demo: visitor flow, deployment modes, topology, hardening |
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
| Consumer passport viewer (three disclosure levels) | `/passport/webapp/` |
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
