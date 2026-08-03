# NIGHTPASS: the battery passport that proves without revealing

**One dataset. Three legally distinct views. Proofs instead of promises. ERP-native.**

## The problem

From **18 February 2027**, EU Battery Regulation 2023/1542 requires a Digital
Product Passport for every EV and LMT battery (e-bikes, scooters) plus every
industrial battery above 2 kWh on the EU market: **7 to 9 million passports a
year from day one**, per battery, QR-accessible, with tiered access for the
public, legitimate-interest parties (recyclers, fleet buyers) and authorities.
The data is competitively sensitive (suppliers, carbon numbers), must be
tamper-evident for auditors, and originates in SAP-class ERPs. Public chains
leak, private databases prove nothing, and manual tooling does not survive
contact with a goods-receipt process. The same DPP mechanic extends to steel,
textiles, tyres and aluminium under EU ESPR, scaling demand to billions of
passports a year: whoever solves batteries owns the template.

## The product

NIGHTPASS is an SAP CAP application on top of our open-source **NIGHTGATE**
plugin, which owns the wallet, indexing and contract calls for the
**Midnight** zero-knowledge network:

- **Three disclosure tiers, enforced server-side** per Annex XIII; an
  on-chain disclosure grant can raise a partner's tier for one passport.
- **On-chain anchoring, zero data leakage**: blake2b-256 payload hash, a
  Merkle content root over the passport's fields and an ACL live in one
  Compact contract; payloads stay AES-256-GCM encrypted off-chain.
- **Field-bound ZK predicates**: prove "recycled cobalt above the legal
  minimum" or "carbon footprint below threshold" on-chain without revealing
  the value, bound to this passport's actual fields. Batchable: up to 8
  claims proven in ONE transaction, one wallet approval, one fee.
- **ERP-native ingest**: a signed CloudEvents webhook turns a goods receipt
  into an anchored passport with no human in the loop; proven end-to-end
  against SAP's public S/4HANA API sandbox (real goods receipts auto-minted
  into anchored, verified passports).
- **The passport lives**: BMS telemetry streams into versioned SoH attributes
  (history queryable per date through the official DPP API), substantive
  changes re-anchor as a new on-chain version while every old version stays
  independently verifiable, battery status follows the legal lifecycle
  (original to second life to waste, mirrored in the DPP status), and a
  Second-Life handover re-registers the passport on-chain to the new
  operator, locking the old one out cryptographically.
- **Zero-funding onboarding**: a fee-sponsor pool pays every wallet's dust
  fees; a new producer needs neither NIGHT nor dust, and passport ids are
  pre-registered on-chain to their owner (no squatting).
- **Catena-X ready**: native CX-0143 aspect export plus a Predicate
  Attestation Credential (PAC) carrying proven claims with
  `valueDisclosed: false`, a capability the Tractus-X stack currently lacks.

## Proof it works (live today)

- **Public demo: [demo.zkpassport.eu](https://demo.zkpassport.eu)**. Anyone
  creates a battery passport on a zero-funded wallet in about five minutes:
  id registered on-chain, the whole anchor lands as ONE batched transaction,
  one confidential value proven with zero knowledge.
- **Public explorer: [zkpassport.eu](https://zkpassport.eu)**. 55+ verifiable
  passports: every anchor and ZK claim verifiable live against Midnight by
  anyone, no account.
- **EU DPP Registry enrolled · 11/11 interoperability scenarios · 0
  validation errors**: enrolled as a verified economic operator in the
  Commission's official registry test environment one week after its launch
  (first battery passport registration submitted, UPI resolving to the live
  explorer); all 11 scenarios of the official DPP Life Cycle API interop
  suite passed; 0 errors against all five official EU BatteryPass validation
  guides (BatteryPass-Ready, DIN DKE SPEC 99100).
- **End-to-end SAP**: real S/4HANA goods receipts auto-minted into anchored,
  verified passports, live against SAP's public API sandbox; SAP Fiori
  producer cockpit.
- ZK proofs run in-process since NIGHTGATE 0.11.0: no proof-server
  infrastructure for development, CI or evaluation. Platform published as
  `@odatano/nightgate` on npm, 1,100+ tests green. Funded via Cardano
  Catalyst.

## Data room

| | |
|---|---|
| Live demo | [demo.zkpassport.eu](https://demo.zkpassport.eu) |
| Live explorer | [zkpassport.eu](https://zkpassport.eu) |
| App code | github.com/ODATANO/NIGHTPASS |
| Platform code | github.com/ODATANO/NIGHTGATE (npm: `@odatano/nightgate`) |
| Cardano bridge | github.com/ODATANO/ODATANO (npm: `@odatano/core`) |
| Pitch deck | NIGHTPASS `docs/PITCHDECK.pdf` |
| Architecture | NIGHTPASS `docs/architecture.md` (10-minute read, diagram included) |
| Live transactions | NIGHTPASS README, "Example live demo flow" section |
| Producer walkthrough | `docs/producer-flow.md` and `docs/producer-walkthrough.md` |
| Homepage | [odatano.dev](https://odatano.dev/) |
| Contact | Maximilian Weber, info@odatano.dev |
