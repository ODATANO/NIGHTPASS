# NIGHTPASS: Architecture

> EU Battery Regulation 2023/1542 Digital Product Passport with selective
> disclosure on Midnight (zero-knowledge). NIGHTPASS (`@odatano/passport`) is the
> consumer application: it builds passports, anchors their integrity hash and a
> field-commitment root on-chain, and serves three lawful disclosure tiers from
> one backend.

![Architecture](./architecture.png)

Five sections: the layering, the data flow, the security model, the field-bound
predicate, and how a consumer pulls the platform in as a CAP plugin.

## 1. Three layers

The system is split into layers that are owned independently. That split is the
product thesis: the chain integration is reusable across any product passport,
not just batteries.

| Layer | Package | Owns |
|---|---|---|
| Platform | `@odatano/nightgate` | The Midnight read/write bridge: OData services, indexer, wallet/proof submission, job tracking. Shipped as a CAP plugin. |
| SDK surface | `@odatano/nightgate` (sub-path exports) | The reusable on-chain primitive, the `attestation-vault` Compact contract, the CDS schema (`midnight.*`), the submission actions, and the browser building blocks (`@odatano/nightgate/browser`). |
| App | `@odatano/passport` | Battery-domain schema, the producer cockpit and consumer viewer, the tier gating, the QR resolver, the off-chain content-root Merkle builder. This repo. |

The app never reaches into the plugin's internals. It configures the plugin via
`cds.requires.nightgate` and calls it over the documented OData surface
(`/api/v1/nightgate`) and the browser building blocks. A capability the app needs
but the platform lacks becomes a feature request against NIGHTGATE, never a local
patch. That is what keeps the platform reusable.

The `attestation-vault` contract is shipped by the plugin and consumed as-is.
There is no contract in this repo (the earlier separate `passport-attestation`
contract was folded into `attestation-vault`).

## 2. Data flow

Two write surfaces, one contract, one read surface.

**Write (producer):** the producer cockpit (`app/producer/webapp`, `ProducerService`)
creates a passport from Annex XIII fields, computes the `blake2b-256` payload hash,
AES-encrypts the payload off-chain, and anchors it on-chain. Anchoring runs three
circuits: `attest` (locks the payload hash under the attester identity),
`bindPassport` (binds `passportId -> payloadHash` for QR resolution), and
`anchorContentRoot` (pins the Merkle root over the provable fields). Disclosure
grants and predicate proofs are further circuit calls.

**Two ways to submit,** same contract, differ only in who holds the key:

1. Server path: `ProducerService` runs the calls through NIGHTGATE's worker wallet
   as async jobs (no UI, no wallet popups), polling `getJobStatus`.
2. Wallet path: the cockpit runs the same calls in-app from the user's Lace wallet
   over the DApp-Connector, using `@odatano/nightgate/browser`.

Offline-first: without a signing session or contract, actions write local tracking
rows so the cockpit and read gate work without the chain.

**Read (consumer):** `PassportService` reads the same data back for the viewer at
three tiers. An `after READ Passports` handler redacts restricted fields per tier.
The QR resolver (`GET /p/:passportId`) picks the tier from the caller's auth and
redirects into the right route.

Only the payload hash, the `passportId` binding, the content root, disclosure
commitments and predicate results ever reach the chain. The payload never does.

## 3. Security model

Four mechanisms, each guarding a different boundary.

**Off-chain confidentiality.** The full payload (chemistry, capacity, supplier
identities, carbon footprint, diligence evidence) is encrypted with AES-256-GCM
under a per-passport key derived via HKDF-SHA256 from the app secret
(`ENCRYPTION_KEY`) salted with `passportId`. Ciphertext layout is
`iv(12) || authTag(16) || ciphertext`. The on-chain hash lets anyone verify
integrity; only a key-holder can decrypt.

**Disclosure tiers: the API is the Annex XIII boundary.** Disclosure is enforced
server-side in `srv/passport-service.ts`, not on the chain, by `after READ`
handlers that strip fields per tier:

- consumer (anonymous): Point 1 public metadata plus QR URL.
- recycler: plus cell chemistry, capacity, recycled-content shares.
- authority (superset of recycler): everything, including supplier identities,
  carbon footprint, diligence docs, and on-chain lineage.

The gating runs on the service projections, so it cannot be bypassed by a crafted
`$expand` or a direct entity read. The client UI mirrors the tier for presentation
only; it is never the boundary.

**On-chain tier entitlement.** The `attestation-vault` `disclosures` ACL
(`grantDisclosure` / `revokeDisclosure`, levels 0/1/2) is a tamper-evident,
revocable registry. NIGHTGATE indexes it into `midnight.DisclosureGrants` and binds
principals to grantee ids via `midnight.GranteeIdentities`. `effectiveGrantsFor`
in the read gate consults it (union with the offline `DisclosureGrantLog`): an
active grant elevates a requester's tier above their login role, scoped per
passport (by `payloadHash`), and degrades to the login role on any lookup failure.

**Integrity and authorization: ZK proofs, not signatures.** On-chain writes go
through Midnight circuits authorized by zero-knowledge proofs. Ownership-gated
circuits (`grantDisclosure`, `bindPassport`, `anchorContentRoot`,
`proveFieldPredicate`) assert the caller is the attester, so authorization holds
without revealing key material or the payload.

## 4. Field-bound predicates

A reveal-or-hide credential cannot prove "the value is below the limit" without
showing the value. NIGHTPASS proves exactly that, and binds the proven value to the
passport's actual field so a verifier knows it came from this passport.

- At attest time the producer builds a Merkle tree over the passport's provable
  fields, each leaf `persistentHash(fieldKey, scaledValue)`, and anchors its root
  with `anchorContentRoot`. The off-chain tree is built with the contract's
  exported `pureCircuits` (`leafHash` / `nodeHash`), so it hashes identically to
  the circuit. Builder: `srv/lib/passport-anchor.ts` (`buildContentRoot`,
  `PROVABLE_FIELDS`).
- `proveFieldPredicate(payloadHash, fieldKey, threshold, op)` recomputes the field
  leaf from witnessed value plus inclusion path, folds it to a root, asserts the
  root equals the anchored content root, then asserts the predicate. The tx only
  lands if both hold, so a successful tx is the proof. The value stays a witness.

Provable fields cover carbon footprint, capacity, recycled content (overall and
per material for cobalt / lithium / nickel), cycle life, round-trip efficiency, and
lead content. Each pairs with a regulatory or buyer-relevant bound (for example
recycled cobalt at least the Article 8 minimum).

Honest limitation: the content root corresponds to the payload hash because the
same attester builds both from the same canonical content at anchor time. A fully
trustless binding would need in-circuit blake2b, which is impractical. The gain is
real: after hardening, a producer cannot prove a value unrelated to the anchored
fields, cannot show different values to different verifiers, and cannot change a
value without re-anchoring (and a new payload hash).

## 5. Build and deploy: the platform as a CAP plugin

A consumer app needs no glue code. CAP discovers the plugin and merges its CDS.

**1. Depend on the plugin.**

```bash
npm install @odatano/nightgate @cap-js/sqlite
```

**2. Configure it** in `package.json` under `cds.requires.nightgate`. The contract
points at the artifact shipped inside the installed plugin:

```jsonc
{
  "cds": { "requires": {
    "db": { "kind": "sqlite" },
    "nightgate": {
      "network": "preview",
      "granteeBinding": "did",
      "crawler": { "enabled": false },
      "contracts": {
        "attestation-vault": {
          "artifactPath": "node_modules/@odatano/nightgate/contracts/attestation-vault/src/managed/attestation-vault/contract/index.js",
          "privateStateId": "attestationVaultPrivateState",
          "zkConfigPath": "node_modules/@odatano/nightgate/contracts/attestation-vault/src/managed/attestation-vault"
        }
      }
    },
    "auth": { "kind": "custom", "impl": "srv/auth.js" }
  } }
}
```

**3. Deploy and run.**

```bash
npm run deploy   # creates the midnight_* tables + the passport schema
npm start        # cds-tsx serve: REQUIRED for the TypeScript service impls
```

> `cds-tsx serve`, not `cds serve`. Plain `cds serve` has no TS loader and silently
> skips `srv/*.ts`, falling back to a generic CRUD handler, so no tier gating and no
> producer actions. The boot log is the tell: `impl: 'srv/passport-service.ts'`
> (good) vs a generic `...-service.js` (impl not loaded).

On boot the services mount side by side and the boot log confirms
`Registered contracts: counter, attestation-vault`.

Live on-chain writes additionally need a funded wallet and a proof server. The
server path needs a signing session and `PASSPORT_CONTRACT_ADDRESS`; the wallet path
needs Lace and a local proof server at `http://localhost:6300`. Without them the
offline path (hash, encrypt, persist, QR, local log rows) still runs.

### At a glance

- Services: `ProducerService` (`/api/v1/producer`), `PassportService` (`/api/v1/passport`), `NightgateService` (`/api/v1/nightgate`).
- Contract: one `attestation-vault` (plugin-shipped): tiered disclosure, passport binding, numeric predicate, and field-bound predicate.
- Crypto: blake2b-256 integrity hash, AES-256-GCM + HKDF-SHA256 payload encryption, persistentHash Merkle content root, ZK-proof authorization.
- UI: producer cockpit (with in-app Lace wallet flow), consumer viewer (three tiers), QR resolver at `/p/:passportId`.
- Chain: Midnight Preview: public metadata, hash, binding, content root, disclosure and predicate results only.
