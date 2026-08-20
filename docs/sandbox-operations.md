# Sponsored NIGHTGATE sandbox: operating guide

A hosted surface that lets an outside caller run the full anchor + ZK-proof
lane against Midnight preprod, UNDER ITS OWN attester identity, with a pool
sponsor wallet paying every dust fee. The caller needs no funds and no server;
it brings only a (throwaway) seed so the attestations are bound to its own
address. We provide the vault and pay the chain. Built to let VeilCore
evaluators run the `veilcore-nightgate-demo` sandbox client against us, and as
the execution layer for a future x402-metered agent API (the caller pays the
API request; we sponsor the dust; the proof is still theirs).

## Identity model (the important part)

Fee sponsoring splits a transaction: the CALLER balances + signs and its
attester id (derived in-circuit from its secret) is what every attestation
carries; the SPONSOR only pays dust. So a caller that supplies its own seed
proves documents UNDER ITS OWN ADDRESS, while we cover the fee. `startTester`
without a seed mints a throwaway identity for a quick anonymous try.

Caveat: NIGHTGATE sponsoring is intra-server (caller + sponsor sessions must be
co-located), so the caller's seed lives on the host, encrypted, for the
duration a sponsored submit needs to sign. A caller that must never surrender
its key is the cross-server-sponsor case NIGHTGATE does not support today.

Service: `SandboxService` at `/api/v1/sandbox` (`srv/sandbox-service.ts` +
`.cds`, entity `sandbox.Runs` reusing `demo.Testers`). Inert unless enabled.

## What it exposes

- `startTester(nickname, seedHex?)` -> `{ testerId, attesterId, shieldedAddress,
  nightAddress, ownIdentity }`: opens a session under the caller's OWN identity
  when `seedHex` (128 hex) is given, else mints a throwaway one. `attesterId` is
  the identity every attestation in the run will carry.
- `prepareProof(documentJson, proofFieldsJson, saltSeed)`: compute-only proxy
  of `prepareDocumentProof` (no dust, no session), so the tester talks to ONE
  surface. Returns `contentRoot`, `schemaId`, `schema`, `fields`, `opening`.
- `runSandbox(testerId, label, runSpecJson)` -> `{ runId, queuePosition }`:
  queues one sponsored run. `runSpecJson` is `{ documents: { A, B? }, claims }`
  where each document carries `payloadHash` (the anchored leaf), `contentRoot`,
  `schemaId`, and each claim is one of `equality | predicate | documentDiff |
  documentIntegrity`.
- `sandboxRunStatus(runId)` -> timeline + `resultJson` (anchored payload hashes,
  content roots, and per-claim verify coordinates).
- `sandboxInfo()` -> open?, shared vault address, network, queue depth, daily
  remaining.

The tester VERIFIES independently against `/api/v1/nightgate`
(`verifyAttestationState` / `verifyPredicateState`, read-only, crawler-free) --
trusting neither the client nor the operator.

## Configuration (env on the host)

Required to turn it on:

- `DEMO_ENABLED=true`
- `ENCRYPTION_KEY=<64 hex>` (encrypts tester wallet secrets at rest; never the
  dev fallback)
- `SANDBOX_CONTRACT_ADDRESS=<addr>` -- a SHARED, pre-deployed attestation vault.
  Deploy once with a funded wallet; testers never deploy. `anchorContentRoot`
  is insert-once per payload hash, so many testers share it (fresh records ->
  distinct payload hashes).
- `PASSPORT_FEE_SPONSOR_WALLET=<walletId[,walletId...]>` -- the sponsor pool
  (reuses NIGHTPASS's producer-wallet secrets mechanism). One sponsor is leased
  per run.
- `NIGHTGATE_SPONSORED_CALLER_SYNC=skip` -- the zero-funded tester wallet then
  needs no chain sync; the sponsor carries the fees.

Caps (all optional, sane defaults):

- `SANDBOX_MAX_PER_DAY` (50), `SANDBOX_MAX_PER_IP_PER_DAY` (5),
  `SANDBOX_MAX_PER_TESTER` (3), `SANDBOX_MAX_QUEUE` (5),
  `SANDBOX_CONCURRENCY` (1, capped by pool size), `DEMO_IP_ALLOWLIST`.

## Deploy checklist

1. Deploy a shared vault once (funded wallet); set `SANDBOX_CONTRACT_ADDRESS`.
2. Fund the sponsor pool wallet(s) with preprod tDUST (register for dust
   generation); list them in `PASSPORT_FEE_SPONSOR_WALLET`.
3. Set `DEMO_ENABLED=true`, `ENCRYPTION_KEY`, `NIGHTGATE_SPONSORED_CALLER_SYNC=skip`.
4. `cds deploy` (adds the `sandbox.Runs` table) or run the schema migration.
5. Confirm `GET`/`POST /api/v1/sandbox/sandboxInfo` returns `enabled: true`.

## Tester experience

The tester sets `SANDBOX_URL=https://<host>` and runs
`npm run sandbox` in `veilcore-nightgate-demo`. Their SDK builds records; the
script generates a throwaway seed (or reuses `SANDBOX_SEED_HEX`), prepares
proofs, submits the sponsored run UNDER THAT IDENTITY, and verifies crawler-
free. Zero dust, zero funds, zero setup beyond the URL; the attestations carry
the caller's own attester id.

## Abuse surface (low: preprod only)

Only tDUST is at risk; refill from the faucet. The per-IP/per-tester/per-day
caps plus the single-flight-per-sponsor lease bound the burn. The action set is
anchor + proofs only (no sends, no deploys). A spammer at worst drains the
sponsor pool for a day.
