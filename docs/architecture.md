# NIGHTPASS: Architecture

> EU Battery Regulation 2023/1542 Digital Product Passport with selective
> disclosure on Midnight (zero-knowledge). NIGHTPASS (`@odatano/passport`) is the
> **consumer application**; it builds passports, anchors their integrity hash
> on-chain, and serves three lawful disclosure tiers from one backend.

![Architecture](./architecture.png)

A 10-minute read. Five sections: the layering, the data flow, the security model,
the compliance mapping, and how a consumer pulls it together.

---

## 1. Three layers

The system is deliberately split into three independently-owned layers. The split
is the product thesis: the chain integration is reusable across *any* product
passport, not just batteries.

| Layer | Package | Owns | Lives in |
|---|---|---|---|
| **Platform** | `@odatano/nightgate` | The Midnight read/write bridge: OData services, the indexer, wallet/proof submission, job tracking. Shipped as a CAP plugin. | Sibling repo (NIGHTGATE) |
| **SDK surface** | `@odatano/nightgate` (sub-path exports) | The reusable on-chain primitive, the **AttestationVault** Compact pattern (`attest` / `grant` / `revoke` / `commitValue` / `provePredicate`) plus the CDS schema (`midnight.Attestations`, `midnight.Documents`) and the submission actions (`anchorDocument`, `submitContractCall`, `getJobStatus`). | NIGHTGATE, consumed via the plugin surface |
| **App** | `@odatano/passport` | Battery-domain schema, the `generatePassport` use case, the three-tier disclosure gating, the QR resolver, the `passport-attestation` contract (which *extends* the AttestationVault pattern). | **This repo** |

**Contract:** the app never reaches into the plugin's internals. It configures the
plugin via `cds.requires.nightgate` and calls it over the documented OData surface
(`/api/v1/nightgate`). A capability the app needs but the platform lacks becomes a
feature request against NIGHTGATE, never a local patch. This is what keeps the
platform reusable.

---

## 2. Data flow

One sentence per arrow in the diagram.

**Pipeline (left → right):**

1. **SAP S/4HANA → CAP** (`build`): a goods-receipt event (mocked in T21) hands a
   batch to `PassportService.generatePassport(batchId)`, which assembles the
   canonical passport payload.
2. **CAP → NIGHTGATE** (`anchor`): the service computes the `blake2b-256` payload
   hash, AES-encrypts the payload off-chain, then calls the plugin's
   `anchorDocument` (which runs the AttestationVault `attest` circuit) and
   `submitContractCall('bindPassport', …)` to bind `passportId → payloadHash`.
3. **NIGHTGATE → Midnight Indexer** (`submit`): the plugin builds, proves, and
   submits the transaction, returning a job id the service polls via
   `getJobStatus` until the tx is included.
4. **Midnight Indexer → Midnight Network** (`prove`): the zero-knowledge proof and
   the attested hash land on the Midnight preprod ledger, **only the hash and the
   binding**, never the payload.

**Disclosure branch (CAP → three UIs):** the same `PassportService` data is read
back by one SAPUI5 app exposed at three routes; an `after READ` handler redacts
each response by the caller's role, so the identical backend yields three lawful
views. The QR resolver (`GET /p/:passportId`) picks the tier from the caller's auth
and redirects into the right route.

---

## 3. Security model

Three mechanisms, each guarding a different boundary.

**Off-chain confidentiality: viewing-key encryption.** Only Annex XIII Point 1
public metadata plus the payload *hash* ever reach the chain. The full payload
(chemistry, capacity, supplier identities, carbon footprint, diligence evidence)
is encrypted with **AES-256-GCM** under a per-passport key derived via
**HKDF-SHA256** from the app secret (`ENCRYPTION_KEY`) salted with the
`passportId`. Ciphertext layout is `iv(12) ‖ authTag(16) ‖ ciphertext`. The
on-chain hash lets anyone verify integrity; only a key-holder can decrypt.

**Disclosure tiers: the API *is* the Annex XIII boundary.** Disclosure is **not**
enforced on the chain; it is enforced server-side in `srv/passport-service.ts` by
`after READ` handlers that strip fields per `tierOf(req)`:

- **consumer** (anonymous) → Point 1 public metadata + QR URL.
- **recycler** (role `recycler`) → + cell chemistry, capacity, recycled-content %.
- **authority** (role `authority`, ⊇ recycler) → everything, incl. supplier
  identities, carbon footprint, diligence docs, and on-chain lineage.

The gating runs on the **service projections**, so it cannot be bypassed by a
crafted `$expand` or a direct entity read. The client UI mirrors the tier for
presentation only, it is never the boundary.

**Integrity & authorization: ZK proofs, not signatures.** On-chain writes go
through Midnight circuits and are authorized by **zero-knowledge proofs**, not
ECDSA signatures. `bindPassport` is gated on attester ownership inside the circuit,
so the binding of a `passportId` to its hash is provably authorized without
revealing the signer's key material or the payload.

---

## 4. Compliance traceability

Every schema field maps to an Annex XIII disclosure class (`db/passport-schema.cds`
carries the per-field comments). The disclosure class is what the tier gating in §3
enforces.

| Entity | Field(s) | Annex XIII | Tier |
|---|---|---|---|
| **Passports** | passportId, manufacturerId, batteryCategory, model, manufactureDate, weightKg, performanceClass, qrCodeUrl | **Point 1** | consumer (public) |
| **Batteries** | serialNumber, cellChemistry, capacityKwh | Points 2/3 (legitimate interest) | recycler |
| **Batteries** | carbonFootprintKgCO₂ | Points 2/3 (restricted) | authority |
| **Batteries** | supplierName | Supplier identity | authority |
| **RecycledMaterials** | material, recycledPercentage | Points 2/3 (legitimate interest) | recycler |
| **RecycledMaterials** | sourceSupplierName | Supplier identity | authority |
| **DiligenceDoc** | docType, documentRef | Points 2/3 (supply-chain due diligence) | authority |

The on-chain anchor (`payloadHash`, `passportIdHash`, `attestationTxHash`,
`contractAddress`) is itself authority-tier lineage, a consumer never sees it.

---

## 5. Build & deploy: pulling the platform as a CAP plugin

A consumer app needs no glue code. CAP discovers the plugin and merges its CDS.

**1. Depend on the plugin.** For published consumers:

```bash
npm install @odatano/nightgate @cap-js/sqlite
```

(During cross-repo development NIGHTGATE is consumed as a **packed tarball**, not
`npm link`, a link loads `@sap/cds` twice and the server won't bind.)

**2. Configure it** in `package.json` under `cds.requires.nightgate`:

```jsonc
{
  "cds": { "requires": {
    "db": { "kind": "sqlite" },
    "nightgate": {
      "network": "preprod",
      "crawler": { "enabled": false },
      "contracts": {
        "passport-attestation": {
          "artifactPath": "contracts/passport-attestation/src/managed/passport-attestation/contract/index.js",
          "privateStateId": "passportAttestationPrivateState",
          "zkConfigPath": "contracts/passport-attestation/src/managed/passport-attestation"
        }
      }
    }
  } }
}
```

**3. Deploy & run.**

```bash
npm run deploy   # creates the midnight_* tables + the passport schema
npm start        # cds-tsx serve: REQUIRED for the TypeScript service impls
```

> **`cds-tsx serve`, not `cds serve`.** Plain `cds serve` has no TS loader and
> silently skips `srv/*.ts`, falling back to a generic CRUD handler, which means
> *no tier gating and no `generatePassport`*. The boot log is the tell:
> `impl: 'srv\passport-service.ts'` (good) vs `…app-service.js` (impl not loaded).

On boot both services mount side by side: `PassportService` at `/api/v1/passport`
and the plugin's `NightgateService` at `/api/v1/nightgate`, and the boot log
confirms `Registered contracts: …, passport-attestation`.

**Live on-chain writes** additionally need a preprod wallet (DUST) and a running
Midnight proof server; without a `sessionId` the deterministic off-chain path
(hash + encrypt + persist + QR) still runs with the tx fields left null.

---

### At a glance

- **Services:** `PassportService` (`/api/v1/passport`) · `NightgateService` (`/api/v1/nightgate`)
- **Contract:** `passport-attestation` (Compact, 6 circuits incl. `bindPassport`), extends the AttestationVault pattern
- **Crypto:** blake2b-256 integrity hash · AES-256-GCM + HKDF-SHA256 payload encryption · ZK-proof authorization
- **UI:** one SAPUI5 app, three routes (consumer / recycler / authority), QR resolver at `/p/:passportId`
- **Chain:** Midnight preprod: public metadata + hash + binding only
