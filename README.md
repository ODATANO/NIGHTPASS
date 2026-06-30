# @odatano/passport - NIGHTPASS

**EU Battery Regulation 2023/1542 Digital Product Passport with three disclosure tiers, backed by zero-knowledge attestations on Midnight.**

[![SAP CAP](https://img.shields.io/badge/SAP%20CAP-%40sap%2Fcds%20%5E9-0faaff?logo=sap)](https://cap.cloud.sap/)
[![Midnight](https://img.shields.io/badge/Midnight-preprod-2b2b6f)](https://midnight.network/)
[![NIGHTGATE](https://img.shields.io/badge/plugin-%40odatano%2Fnightgate-6f42c1)](https://github.com/ODATANO/NIGHTGATE)
[![Catena-X](https://img.shields.io/badge/Catena--X-CX--0143-009f4d)](https://catena-x.net/)
[![Compliance](https://img.shields.io/badge/EU%20Battery%20Reg-2023%2F1542-003399)](https://eur-lex.europa.eu/eli/reg/2023/1542/oj)

`NIGHTPASS` implements the EU Battery Passport and answers one dataset with a different view per audience (**consumer / recycler / authority**), while proving sensitive claims (e.g. "recycled cobalt share ≥ threshold") *without revealing the underlying value*. Public metadata plus a payload hash are anchored on-chain; everything else stays encrypted off-chain, and the disclosure tier is enforced at the API layer.

It consumes [`@odatano/nightgate`](https://github.com/ODATANO/NIGHTGATE) as a CAP plugin (via `cds.requires.nightgate`).

## The problem

The EU Battery Regulation mandates a Digital Product Passport per battery, but its data carries conflicting disclosure rules, so a single dataset must answer different audiences with different views:

| Tier | Audience | Annex XIII scope |
|---|---|---|
| **consumer** | public / phone scan | Point 1 (public metadata) + QR |
| **recycler** | legitimate-interest parties | + cell chemistry, capacity, recycled-material shares (Points 2/3) |
| **authority** | regulators | + supplier identities, carbon footprint, due-diligence docs, on-chain lineage |

On top of that, some claims (e.g. "recycled cobalt share ≥ threshold") must be **provable without revealing the value**, which reveal/hide credentials cannot express. That capability is delivered as a **Predicate Attestation Credential (PAC)** (see [Catena-X integration](#catena-x--tractus-x-integration)).

## Architecture

A five-layer pipeline: **SAP → CAP → NIGHTGATE → Midnight Indexer → Midnight chain**, with the three disclosure UIs branching off the CAP layer.

![Architecture](docs/architecture.png)

Full write-up in [`docs/architecture.md`](docs/architecture.md)

**On-chain vs off-chain.** Only a `payloadHash` (blake2b-256) and the `passportId → payloadHash` binding go on-chain; the sensitive payload is AES-256-GCM encrypted off-chain. Midnight has only public ledger state (plaintext for all) and private witness state (client-side), so the chain physically cannot hold tier-restricted cleartext. The split is deliberate: **verifying a claim** and **authorizing a tier** move on-chain; **delivering tier-specific cleartext** stays off-chain in the API layer.

**On-chain tier entitlement (NIGHTGATE 0.3.4).** The AttestationVault `disclosures` ACL (`grantDisclosure` / `revokeDisclosure`, levels 0/1/2 = consumer/recycler/authority) is a tamper-evident, revocable entitlement registry. NIGHTGATE indexes it into `midnight.DisclosureGrants` and binds principals to grantee ids via `midnight.GranteeIdentities`. The tier gate in `srv/passport-service.ts` consults this ACL: an active on-chain grant **elevates** a requester's tier above their CAP role, scoped **per passport** (by `payloadHash`) so one passport's grant never leaks onto another. Elevation is additive and degrades to the local role on any lookup failure.

## Quick start

```bash
npm install
cp .env.example .env   # then set ENCRYPTION_KEY (.env is gitignored)
npm run deploy   # creates db/passport.db: domain tables + the 23 midnight_* plugin tables
npm start        # cds-tsx serve  →  http://localhost:4004
```

### Services on :4004

| Service | Path | Source |
|---|---|---|
| PassportService | `/api/v1/passport` | this repo (`srv/`) |
| NightgateService (+ indexer / analytics / admin) | `/api/v1/nightgate` | `@odatano/nightgate` plugin |
| Passport UI (3 tiers) | `/passport/webapp/` | `app/passport/webapp/` |
| Disclosure connector (Lace) | `/connector/dist/` | `app/connector/` (Vite bundle) |

### Disclosure tiers (dev auth)

In development, auth is `mocked`. Anonymous requests resolve to **consumer**; log in as `recycler` / `recycler` or `authority` / `authority` (authority ⊇ recycler) to widen the view. The boundary is enforced server-side by `after READ` handlers in `srv/passport-service.ts` that redact restricted fields per tier; an active on-chain grant elevates the tier per passport.

### QR resolver

`GET /p/:passportId` reads Basic-Auth to pick the tier and 302-redirects into the SAPUI5 app; `GET /qr/:file.png` renders a QR PNG on the fly for the current host.

## How a passport is created

`generatePassport(batchId, sessionId?)` builds a batch, computes a blake2b-256 `payloadHash` (+ `passportIdHash`), AES-256-GCM-encrypts the payload (HKDF key from `ENCRYPTION_KEY` + passportId), and produces a QR URL. With a `sessionId` it anchors on-chain via the plugin (`anchorDocument` + `bindPassport` / `submitContractCall`), polls `getJobStatus`, then inserts the row. The offline path is live-verified; the on-chain run requires a wallet + DUST + a proof server on preprod.

## Browser connector (Lace)

`app/connector/` is the browser human-attester path: connect a Midnight wallet (Lace) over the DApp-Connector and run `deploy` / `attest` / `grantDisclosure` / `revokeDisclosure` / `commitValue` / `provePredicate` on the AttestationVault directly. It uses NIGHTGATE's `@odatano/nightgate/browser` building blocks (manifest discovery, zk-config over HTTP, provider assembly, call helpers).

> **Two paths, one contract — automatic vs manual.** The **SAP/CAP app** (`PassportService`, `srv/`) is the production path: `generatePassport` anchors the hash, binds `passportId → payloadHash`, and issues predicate attestations **automatically, in the background**, server-side via NIGHTGATE's worker wallet (async jobs, no UI, no wallet popups). This **browser connector** is the **manual, human-attester path**: the same AttestationVault operations driven interactively from a user's own Lace wallet, with visible steps, balances, and on-chain verification — for demos and self-custodial attestation. Both target the same contract on the same chain; they differ only in *who holds the key* and *whether it is automated*.

```bash
npm run build:connector     # Vite build into app/connector/dist (WASM needs Vite, not esbuild)
npm start                   # serves the page at http://localhost:4004/connector/dist/
```

### Demo flow (what the page does)

A presentation-ready single page. The **wallet connect sits top-right** and shows live **DUST + NIGHT balances** after connecting (refreshed after every tx); the steps run top to bottom; an optional **activity log** toggles in from the hero. Every on-chain id links to the **Preview Explorer** (`/contracts/0x…`, `/transactions/0x…`).

1. **Contract** — target an existing AttestationVault or **deploy** a fresh one from the wallet. A **Check vault on chain** button confirms (green) whether a vault is already deployed at the address (indexer `contractAction` lookup); auto-runs on load.
2. **Battery-pass values → hashes** — a full **EU 2023/1542 Annex XIII** passport (private, off-chain) plus its public metadata subset; sha256 → `payloadHash` / `metadataHash`.
3. **Attest** — anchor the passport hashes on the vault under the wallet's attester identity.
4. **Disclosure control** — `grantDisclosure` / `revokeDisclosure` per audience tier (0/1/2).
5. **Predicate proof (`value ≤ threshold`)** — the PAC capability. The hidden value is **pulled from a real passport field** (JSON path, default `carbonFootprint.total_gCO2e_per_kWh`), committed, then proven against a public threshold in zero-knowledge. The value never leaves the browser; only the commitment and a `true` result land on-chain. Lower the threshold to demo a rejected (false) proof.
6. **Verify on chain** — scans the indexer for a submitted tx; the badge turns green on SUCCESS (auto-runs after every action) with an Explorer link.
7. **Export Catena-X credential (PAC)** — bundles the attestation + predicate proof into a downloadable Predicate Attestation Credential JSON (W3C-VC-shaped, profile CX-0143) with a **live preview**. `valueDisclosed: false` — the proven value is not included.
8. **Verify credential (verifier side)** — the consumer loads or pastes a PAC and independently confirms on-chain that its predicate proof is present and SUCCESS, proving the claim **without ever seeing the value** (indexer-trust, CX-0143). Closes the issue → verify loop.

### How it works (key facts)

Open the page with Lace (Midnight) installed, unlocked, and funded with tDUST; connect; optionally click **Deploy new AttestationVault** (the deployed address auto-fills the contract field); then attest / grant / revoke.

- **The network follows the wallet.** Lace's `getConfiguration()` supplies the indexer URI and network id, so the connector targets whatever network Lace is set to. The one literal to match is `NETWORK` in `connector.mjs` (currently `preview`).
- **Local proof server required.** Prove runs against `http://localhost:6300` (`docker compose -f <NIGHTGATE>/docker/docker-compose.yml up -d proof-server` with `NIGHTGATE_PROOF_NETWORK=<net>`); the hosted proof server omits the CORS header on the POST response, so a browser fetch is blocked.
- **`submitTx` returns the transaction identifier, not the serialized tx.** The indexer's `watchForTxData(txId)` matches `offset.identifier` against a transaction's `identifiers`. Lace's `submitTransaction` returns `undefined`, so the adapter derives the id via `ledger.Transaction.deserialize('signature','proof','binding', bytes).identifiers()[0]` (with the pre-balance identifier as fallback). Returning the serialized tx instead produced an oversized request and an indexer `Failed to fetch`.
- The page CSP (`cds.requires.nightgate.contentSecurityPolicy`) must allow `https://*.midnight.network`, and `app/connector/dist` is a gitignored build artifact.

### Live verification (Preview, 2026-06-30)

The full prove -> balance -> submit -> finalize round-trip is live-proven on the Midnight **Preview** network via Lace, both transactions submitted from the funded Lace wallet through the same `makeConnectorWalletAdapter`:

| Step | On-chain result (Preview Explorer links) |
|---|---|
| Deploy AttestationVault | contract [`0x89a952c6…65280`](https://preview.midnightexplorer.com/contracts/0x89a952c62503e714ec59e7d1e5d6e54dc5d22bb87234bd62108cb0f684765280) · deploy tx [`0x50017232…17c66`](https://preview.midnightexplorer.com/transactions/0x50017232b3c1e21f42a06e844765249932897f62b4340e8930c0f21f06617c66) (block 1399183, SUCCESS) |
| `attest(payloadHash, metadataHash)` | tx [`0x1f0f6b10…73b463`](https://preview.midnightexplorer.com/transactions/0x1f0f6b108041f17733acf35b547da2ca727aea6081c3d509397a6c453e73b463) (block 1399202, SUCCESS) |

The Preview public indexer (`https://indexer.preview.midnight.network/api/v4/graphql`, CORS open) resolved each transaction. Note the explorer keys transactions by their 32-byte **hash** (shown above), whereas the SDK watches by the 33-byte transaction **identifier**; the local proof server ran with `--network preview`.

## Contracts (Compact / Midnight)

`contracts/passport-attestation/src/passport-attestation.compact` carries the AttestationVault pattern (attest / grant / revoke / commitValue / provePredicate) plus a `bindPassport` circuit that anchors `passportId → payload_hash`. It is re-embedded here (not inherited) because Compact cannot inherit ledger state across contracts.


```bash
wsl -e bash -lc 'export PATH=$HOME/.local/bin:$PATH; \
  cd /mnt/c/<path-to-repo>/contracts/passport-attestation && \
  compact compile src/passport-attestation.compact src/managed/passport-attestation'
```

## Catena-X / Tractus-X integration

Catena-X is the automotive-industry dataspace standard (Tractus-X is its Eclipse reference implementation); the Battery Passport is use case **CX-0143**. Tractus-X has no zero-knowledge / predicate / range-proof capability; the closest, the draft Data Trust & Security KIT AAC-SD, only does attribute reveal/hide via BBS+. NIGHTPASS targets that gap, exposing the passport into the dataspace as a **Predicate Attestation Credential (PAC)**, the missing `zkPredicate` mode (prove `value ≤ threshold` without revealing the value). The intended attach point is a new credential profile beside AAC, riding the Digital Twin Registry `/credential` discovery convention over the EDC data plane. The PAC glue lives in `tractusx/`; the ZK primitive lives in the NIGHTGATE plugin (`issuePredicateAttestation` / `verifyPredicateAttestation`).

**Verification model.** Verification is currently **indexer-trust**: the consumer confirms the `provePredicate` transaction was included and succeeded (the ledger only accepts the tx if the in-circuit asserts held, so a successful tx *is* the proof). This relies on NIGHTGATE's own indexer, which must be **enabled and caught up** (the crawler is disabled in the current config). Trust depends on *whose* indexer: a self-sovereign verifier must run their own NIGHTGATE or point at a neutral Midnight indexer, not the issuer's. Portable verifier-key-only verification is deferred because Midnight exposes no standalone off-chain proof verifier.

## Repository layout

```
db/passport-schema.cds              Passports / Batteries / RecycledMaterials / DiligenceDoc (Annex XIII tier comments)
db/data/passport-*.csv              CSV seeds
srv/passport-service.{cds,ts}       PassportService + generatePassport + tier-gating handlers
srv/server.ts                       QR + resolver Express routes (cds.on bootstrap)
app/passport/webapp/                SAPUI5 Freestyle app, one app / three routes (consumer, recycler, authority)
app/connector/                      Browser Lace DApp-Connector page (Vite bundle) for attest / grant / revoke
contracts/passport-attestation/     Compact contract (bindPassport + AttestationVault pattern) + managed ZK artefacts
docs/                               architecture.svg/png/md
tractusx/pac/                       Predicate Attestation Credential glue + indexer-trust verify demo
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Serve via `cds-tsx serve` (the only correct way, see note above) |
| `npm run deploy` | Deploy the merged model to `db/passport.db` |
| `npm run pac:demo` | Build a Predicate Attestation Credential and verify it the portable way (`tractusx/pac/build-pac.mts`) |
| `npm run build:connector` | Build the Lace connector page (Vite) into `app/connector/dist` |

## Status

**Working and verified:** NIGHTGATE plugin mount (23 `midnight_*` tables + both services on :4004); domain schema with Annex XIII tier comments and nested `$expand`; the `passport-attestation` Compact contract (6 circuits / 28 managed artefacts, registered and deploy-ready); the three disclosure UIs with server-side tier gating (browser smoke 12/12 green); QR + resolver; architecture docs. **Browser connector (Lace) live-verified on Preview** — full wallet-driven demo flow (deploy → attest → commit → zero-knowledge predicate proof → export PAC → verifier-side credential check), with live DUST/NIGHT balances and Explorer-linked on-chain verification; deploy + attest landed on-chain (see [Live verification](#live-verification-preview-2026-06-30)).

**In test / pending live run:** `generatePassport` is live-verified on the offline path (200 + row with 64-hex hashes + encrypted cipher; duplicate → 409, unknown batch → 404); the on-chain run with a wallet is outstanding, blocked on a running Indexer. The PAC verify demo (`verifyPredicateViaIndexer` in `tractusx/pac/`) returns correct `verified:false` until a proven predicate attestation exists.

## Glossary

- **PAC** (*Predicate Attestation Credential*): the credential NIGHTPASS/NIGHTGATE introduces, providing the `zkPredicate` mode, a zero-knowledge predicate proof (e.g. "recycled share ≥ X%") that proves the statement **without disclosing the value**. Attaches as its own profile beside AAC.
- **AAC** (*Attribute Attestation Credential*, AAC-SD): the Tractus-X Data Trust & Security KIT credential profile. Reveals or hides attributes via BBS+, but has no "prove a property without revealing the value" mode, the gap NIGHTPASS fills.
- **EDC** (*Eclipse Dataspace Connector*): the standard component for sovereign data exchange, separating the control plane (policy negotiation) from the data plane (transfer). PAC is delivered over the data plane.
- **BBS+**: a selective-disclosure signature scheme (BBS over BLS12-381, multi-message variant). Supports reveal/hide and unlinkable presentations, but **cannot** produce predicate proofs, the capability AAC-SD lacks and PAC adds.
