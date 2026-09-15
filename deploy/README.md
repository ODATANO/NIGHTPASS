# NIGHTPASS public demo: five steps to live

> The optional "Try it" demo instance (visitors anchor their own sponsored
> passport) has its own rollout section at the bottom of this file. It is
> OFF by default (compose profile `demo`).

Turnkey deployment of the public demo (viewer + explorer + QR resolver +
anonymous on-chain verification) on a small VPS with automatic TLS.
Background and hardening details: `docs/public-demo.md`.

Recommended host: Hetzner Cloud CX22 (2 vCPU / 4 GB, EU location) or any
Docker-capable VM with ports 80/443 open. The instance holds NO wallet
secrets; it reads and verifies only.

## Steps

1. **DNS**: create an A record for your demo subdomain (for example
   `passport.<your-domain>`) pointing at the server's IPv4. Do this first;
   Caddy needs the record live to obtain the certificate.

2. **Local prep** (on your dev machine, in the repo):
   ```bash
   node scripts/set-qr-host.mjs https://passport.<your-domain>   # QR urls -> real host
   cp deploy/.env.example deploy/.env                            # then fill it in
   ```
   Fill `deploy/.env`: domain, ENCRYPTION_KEY (same as local .env), strong
   DEMO_PASS_* values and a high-entropy `POSTGRES_PASSWORD`.

3. **Server prep**: install Docker (`curl -fsSL https://get.docker.com | sh`),
   then copy the repo onto the server (`git clone` + copy `deploy/.env` and
   `deploy/.env` over; it is gitignored).

4. **Start PostgreSQL and the app** (from the repo root on the server):
   ```bash
   cd deploy
   docker compose up -d --build
   ```

5. **Smoke check** from anywhere:
   - `https://passport.<your-domain>/explorer/` shows the passports, "Verify all" turns green
   - `https://passport.<your-domain>/p/BAT-FRESH-20260717125619` resolves a QR scan into the consumer view
   - `https://passport.<your-domain>/api/v1/passport/verifyOnChain(passportId='BAT-FRESH-20260717125619')`
     returns `"verified": true` (first call cold ~30-60s, then seconds)

## Notes

- `deploy/.env` is gitignored; move it to the server via scp, never commit it.
- PostgreSQL data lives in `passport-pg-data`. Back up with `pg_dump` before
  upgrades and verify restores regularly; a Docker volume is persistence, not
  a backup.
  ```bash
  docker compose exec -T postgres pg_dump -U nightpass -Fc nightpass > nightpass.dump
  # Verify into a separate disposable database/container before relying on it.
  ```
- The DPP conformance API stays OFF on public hosts (`DPP_API_ENABLED` unset);
  it is a test surface with unauthenticated writes by design.
- Anchoring/proving stays on your work machine; the public instance only
  serves and verifies. New passports reach it by re-baking + re-copying the
  DB, or later via the `PASSPORT_SOURCES` federation described in
  docs/public-demo.md.

## Try-it demo instance (optional, compose profile `demo`)

A second container (`nightpass-demo` + an internal `proof-server`) lets
visitors anchor their OWN passport on `demo.<your-domain>`. Since
2026-08-28 the demo runs on the REMOTE transport: the container holds no
wallet and no NIGHT. Each run derives a throwaway seed, builds and proves
its transactions locally (`@odatano/nightgate-tx`, proving on the internal
proof-server) and hands the fee-unpaid bytes to the hosted NIGHTGATE
(`api.nightgate.dev`) under an agent grant; the hosted sponsor pool pays
the dust. Per run: attest + anchorContentRoot + bindDocument (one batch), the
claim cart (one batch), optionally the second-life re-anchor. Verification
reads go through the same API with the token. Runs start immediately (no
wallet sync). Rollout:

1. **DNS**: A record for `demo.<your-domain>` (the wildcard already covers it
   on zkpassport.eu).
2. **Hosted side** (operator of the NIGHTGATE API): the demo vault in the
   sponsor policy (`allowedContracts` + `bindDocument` in `allowedCircuits`),
   then `createAgentGrant(allowedActions: ['sponsorUnboundTransaction'],
   sponsorSessionId: <pool sentinel>, allowedContracts: [<vault>],
   allowedCircuits: [attest, bindDocument, anchorContentRoot,
   proveFieldPredicate, proveFieldMembership], maxJobsPerDay: <DEMO_MAX_PER_DAY x 4>,
   agentLabel: 'nightpass-demo')`. The token is shown once. The vault must be
   the lineage the hosted API and the installed `@odatano/nightgate-tx` build
   calls for (0.24 / 0.6.x: lineage 4); a grant from an earlier lineage lists
   `bindPassport` and refuses the new circuit name.
3. **Config**: `cp deploy/.env.demo.example deploy/.env.demo` and fill it:
   `DEMO_NIGHTGATE_AGENT_TOKEN`, `PASSPORT_CONTRACT_ADDRESS` (the vault from
   step 2), a fresh `ENCRYPTION_KEY` (payload cipher + tester seeds at rest).
   Add `TRY_DOMAIN=demo.<your-domain>` to `deploy/.env`; scp `.env.demo` to
   the server (gitignored, mode 600).
4. **Caddy**: `cp Caddyfile.demo Caddyfile` on the server (adds the demo
   site), then `docker compose restart caddy`.
5. **Schema, then start**: deploy the schema as a one-off so a slow
   `cds.deploy` can never eat the healthcheck window, then start:
   ```bash
   docker compose --profile demo build nightpass-demo
   docker compose --profile demo run --rm --no-deps nightpass-demo npm run deploy
   docker compose --profile demo up -d
   ```
   The first boot fetches the prover keys from the hosted `/zk-config` into
   the `passport-demo-zk-cache` volume (`remote lane zk assets ready` in the
   log); later boots find them cached.
6. **Smoke**: `https://demo.<your-domain>/api/v1/demo/demoInfo()` shows
   `"enabled": true`; run one visitor flow from a phone. Expect two anchor
   txs (attest, then root + bind), ONE proof tx for all picked claims, and on
   the done view the QR plus an explorer link that auto-verifies green. On
   the hosted side the grant's `jobsUsed` grows by 3 per run (4 with the
   second-life act).

Fallback: `DEMO_TRANSPORT=plugin` keeps the in-process lane (server wallets,
sponsor pool, `mem_limit` 12g); the wallet/sponsor keys in the example file
document that profile.

Ops notes: the demo DB volume is disposable (visitor data only); caps are
env-tunable in `.env.demo`; the second line of defence is the grant's
`maxJobsPerDay` on the hosted side; rotating the token means a new grant
(`revokeAgentGrant` the old one) and a container restart.

### Periodic restart (stale sponsor sessions)

Over long uptime (~30h+) the indexer websockets drop (`Wallet.Sync:
[object CloseEvent]` in the logs) and the boot-prewarmed sponsor-pool
sessions go inactive, so every anchor then fails with `Sponsor session not
found, inactive, or not usable by this caller` while `startTester` /
`createDemoPassport` still succeed. `demo-restart.sh` pre-empts this: it
waits out any in-flight visitor run (up to 3 x 10 min), restarts only the
`nightpass-demo` container (main site untouched), and logs the sponsor
prewarm result. Install as a daily cron on the server:

```bash
( crontab -l 2>/dev/null | grep -v demo-restart.sh; \
  echo "17 5 * * * bash /root/nightpass/deploy/demo-restart.sh >> /root/nightpass-demo-restart.log 2>&1" ) | crontab -
```

The `bash` prefix is deliberate: a deploy that lays the repo down as a tar can
drop the exec bit, and a cron line calling the path directly then dies with
"Permission denied" (that killed the nightly restart for two days once).

Check runs with `tail -20 /root/nightpass-demo-restart.log` (expect
`prewarm CAUGHT UP lines: 3`).

### Auto-heal (both sites)

`autoheal.sh <service>` recovers a dead or wedged container within 5 minutes.
Both `nightpass` and `nightpass-demo` carry a compose healthcheck (a node-fetch
against their own anonymous endpoint), and the script force-recreates the
container when it is not running or reports unhealthy. Docker's restart policy
covers neither case: it ignores health, and a wedged process can survive
`docker restart` with "did not receive an exit event", which is exactly how the
2026-08-02 outage happened. Install one cron line per service:

```bash
( crontab -l 2>/dev/null | grep -v autoheal.sh; \
  echo "*/5 * * * * bash /root/nightpass/deploy/autoheal.sh nightpass      >> /root/nightpass-autoheal.log 2>&1"; \
  echo "*/5 * * * * bash /root/nightpass/deploy/autoheal.sh nightpass-demo >> /root/nightpass-demo-autoheal.log 2>&1" ) | crontab -
```

The logs stay empty while everything is healthy. Auto-heal and the nightly
restart take the same `flock`, so they cannot fight over the same container.

**Kill switch:** a plain `docker compose stop` is undone within 5 minutes.
To keep a service down, `touch /root/nightpass/deploy/.<service>-off` first
(for example `.nightpass-demo-off`) and remove the file to re-enable.

### Database backups

`backup-db.sh` dumps both databases (`pg_dump -Fc`, restore with `pg_restore`)
and prunes dumps older than `RETAIN_DAYS` (default 14):

```bash
( crontab -l 2>/dev/null | grep -v backup-db.sh; \
  echo "23 3 * * * bash /root/nightpass/deploy/backup-db.sh >> /root/nightpass-backup.log 2>&1" ) | crontab -
```

Set `OFFSITE_CMD` in the cron line (for example an `rclone copy`) to ship the
dumps off the box; on their own they survive an accidental delete but not a
host loss.

### Key material

A database dump is NOT a full backup. `deploy/.env` and `deploy/.env.demo` hold
the wallet mnemonics and the `ENCRYPTION_KEY`, and without the matching key
every `payloadCipher` in a restored dump stays unreadable forever. Keep an
encrypted copy of both files (and of `secrets/producer-wallets.env` from the
development machine) somewhere that is not this server and not that one laptop.
