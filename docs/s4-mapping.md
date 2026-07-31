# S/4HANA goods receipt to NIGHTPASS passport: the mapping

The promise behind this document: *a goods receipt posted in S/4 mints an
anchored battery passport without a manual step.*

```
S/4HANA                      bridge (this repo)                 NIGHTPASS
--------                     ------------------                 ---------
goods receipt posted    ->   scripts/s4-bridge.mts        ->   POST /api/v1/passport/erp-events
(material document,          polls API_MATERIAL_DOCUMENT_SRV,  (HMAC-verified CloudEvent)
movement type 101)           maps via product master            -> createPassport
                                                                -> auto-anchor on Midnight
                                                                   (ERP_AUTO_ANCHOR=true)
```

Nothing on the NIGHTPASS side is new: the webhook, `createPassport`, the
anchor runner and the idempotency were live-proven with the EQUINOX emitter.
The bridge is a second emitter that speaks S/4 on its inbound side.

## 1. Where each Annex XIII field comes from

An ERP material document records the logistics event, not the product
engineering data. The EU Battery Regulation fields therefore come from two
sources:

* **The material document** (who received what, when, in which batch). Read
  live from `API_MATERIAL_DOCUMENT_SRV`.
* **The product master** (what this material IS: chemistry, capacity, carbon
  footprint, recycled shares, due-diligence scheme). In a real landscape this
  lives in PLM, supplier declarations and custom fields on the material
  master. The bridge models it as a JSON lookup keyed by S/4 Material number:
  `config/s4-product-master.json` (start from the checked-in
  `s4-product-master.example.json`).

### Field table

| PassportInput field | Source | S/4 / master field | Annex XIII |
|---|---|---|---|
| `passportId` | derived | `BAT-<Material>-<MaterialDocument><Item>` (charset-safe, stable per document item, fits the 50-char UPI budget) | Point 1 (unique identifier) |
| `manufacturerId` | product master | `manufacturerId` | Point 1 |
| `batteryCategory` | product master | `batteryCategory` (EV, INDUSTRIAL, LMT, STATIONARY, INDUSTRIAL_NO_BMS) | Point 1 |
| `model` | product master | `model` | Point 1 |
| `manufactureDate` | document | item `ManufactureDate`, else header `PostingDate`, else `DocumentDate` (OData V2 `/Date(ms)/` parsed) | Point 1 |
| `weightKg` | S/4 product master API, else config | `A_Product.NetWeight` (gross as fallback, KG/G) via `API_PRODUCT_SRV` enrichment; configured `weightKg` when the lookup fails or is off | Point 1 |
| `performanceClass` | product master | `performanceClass` (A..G) | Point 1 |
| `batteries[].serialNumber` | document | `SN-<Batch>` when the item carries a batch, else `SN-<MaterialDocument>-<Item>` | Point 1 |
| `batteries[].cellChemistry` | product master | `battery.cellChemistry` | Points 2/3 (legitimate interest) |
| `batteries[].capacityKwh` | product master | `battery.capacityKwh` | Points 2/3 |
| `batteries[].carbonFootprintKgCO2` | product master | `battery.carbonFootprintKgCO2` | Points 2/3 (authority tier here; ZK claims prove thresholds publicly) |
| `batteries[].supplierName` | product master | `battery.supplierName` | Authority tier (supplier identity) |
| `recycledMaterials[]` | product master | `recycledMaterials` (Co/Li/Ni shares + source suppliers) | Points 2/3 |
| `diligenceDocs[]` | product master | `diligenceDocs`, default `supply-chain-due-diligence-report` | Authority tier |

Selection rules on the document side:

* Only items with **GoodsMovementType 101** (goods receipt for purchase or
  production order) are considered; override with `S4_MOVEMENT_TYPES`.
* Items flagged `GoodsMovementIsCancelled` are dropped.
* Materials without a product-master entry are skipped for good (a plant
  receives packaging and screws too; only listed battery materials mint
  passports).
* One passport per document item. Quantities above 1 piece would need the
  serial-number API (`API_SERIALNBR`) to mint per-unit passports; out of
  scope until a pilot needs it.

The 65-plus guide attributes (BatteryPass-Ready longlist) are attached by
`createPassport` itself via the category-aware defaults, exactly as in the
cockpit flow. The product master only carries what differs per material.

## 2. Running the bridge

```bash
# one poll cycle (good for cron or a smoke test)
node --import tsx scripts/s4-bridge.mts --once

# poll loop
node --import tsx scripts/s4-bridge.mts
```

| Env | Meaning | Default |
|---|---|---|
| `S4_BASE_URL` | S/4 host, e.g. `https://sandbox.api.sap.com/s4hanacloud` | required |
| `S4_API_KEY` | api.sap.com sandbox key (sent as `APIKey` header) | - |
| `S4_USER` / `S4_PASSWORD` | basic auth for trial/CAL systems | - |
| `S4_MOVEMENT_TYPES` | comma-separated goods movement types | `101` |
| `S4_TOP` | documents per poll page | `50` |
| `S4_PRODUCT_MASTER` | product-master JSON path | `config/s4-product-master.json` |
| `S4_STATE_FILE` | seen-state file | `secrets/s4-bridge-state.json` |
| `S4_POLL_INTERVAL_MS` | loop interval | `60000` |
| `S4_SOURCE` | CloudEvent source id | `urn:odatano:s4-bridge` |
| `S4_PRODUCT_LOOKUP` | `off` disables the API_PRODUCT_SRV enrichment | `on` |
| `S4_POST_DELAY_MS` | pause between webhook posts in one cycle (serializes on-chain anchors when many receipts arrive at once) | `0` |
| `NIGHTPASS_BASE` | target NIGHTPASS instance | `http://localhost:4004` |
| `ERP_WEBHOOK_SECRET` | shared HMAC secret (must match the server) | required |

Delivery semantics: at-least-once. The passport id is a pure function of the
document item, and the webhook answers `200 duplicate` for known ids, so
replays are harmless. The state file only keeps quiet cycles cheap; deleting
it is always safe. Webhook failures are retried on the next cycle; unknown
materials are not.

Verification: `test/unit/s4-material-document.test.ts` pins the mapping;
`test/integration/s4-bridge-e2e.mjs` drives a mock S/4 through the real
bridge and webhook against a running server (chain-free, offline drafts).

## 3. The three S/4 lanes

### Lane A: api.sap.com sandbox (zero setup, read-only)

Register at <https://api.sap.com>, show the `API_MATERIAL_DOCUMENT_SRV` API
page, "Show API Key". The sandbox serves canned demo documents, which is
enough to prove the wire: set `S4_BASE_URL=https://sandbox.api.sap.com/s4hanacloud`
and `S4_API_KEY`, add the sandbox's material numbers to the product master,
run `--once`. No postings possible, so the demo story is "documents that
exist in S/4 become passports", not "watch me post".

### Lane B: S/4HANA Cloud

An S/4HANA Cloud trial or an SAP CAL appliance allows real MIGO postings. Point the
bridge at it with `S4_USER`/`S4_PASSWORD`, post a goods receipt for a listed
material, watch the passport appear anchored.

### Lane C: Event Mesh (productive push instead of poll)

For production the poll becomes a push: S/4HANA Cloud raises
`sap.s4.beh.materialdocument.v1.MaterialDocument.Created.v1` through the
Enterprise Event Enablement communication arrangement (`SAP_COM_0092`) into
SAP Event Mesh. The event is a thin notification (document key only), so the
consumer does exactly what the bridge does today: read the document via
`API_MATERIAL_DOCUMENT_SRV`, map, sign, POST. The mapper and the webhook are
shared; only the trigger changes from timer to AMQP/webhook subscription.
See also `docs/btp-integration.md` section 6.3.

## 4. What you need to provision

* **Lane A:** an api.sap.com account and API key. Minutes, free.
* **Lane B:** an S/4HANA Cloud trial (availability varies) or a CAL instance
  (hyperscaler account plus SAP CAL, hourly cost while running).
* **Lane C:** a BTP subaccount with Event Mesh and an S/4HANA Cloud tenant
  where you can maintain communication arrangements. Pilot-stage work.
* In all lanes: `ERP_WEBHOOK_SECRET` on the NIGHTPASS server, plus
  `ERP_AUTO_ANCHOR=true` and a signing wallet (`PRODUCER_*`,
  `PASSPORT_CONTRACT_ADDRESS`) when receipts should anchor immediately
  instead of landing as drafts.
