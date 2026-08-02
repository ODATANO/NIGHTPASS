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
visitors anchor their OWN sponsored passport on `demo.<your-domain>`.
Prepared but NOT part of the default stack. Rollout:

Since 2026-07-24 the demo runs on PREPROD with the 0.10.x feature set:
ownership pre-registration (registrar step), the whole anchor as ONE batched
transaction, and the instance's own passport explorer
(`PASSPORT_PUBLIC_SURFACE=demo,explorer`; the done view links
`/explorer/#/p/<id>`). Publishing to zkpassport.eu (a preview instance) is
off.

1. **DNS**: A record for `demo.<your-domain>` (the wildcard already covers it
   on zkpassport.eu).
2. **Sponsor pool** (dev machine): `scripts/zz-demo-sponsors-preprod.mjs`
   derives the PREPROD identities of the existing S1..S3 sponsor mnemonics,
   funds each with 1000 tNIGHT from Main and dust-registers them (run against
   a local preprod instance, e.g. `scripts/zz-demo-server-preprod.mjs`).
3. **Config**: `cp deploy/.env.demo.example deploy/.env.demo` and fill it:
   sponsor secrets from `DEMO_SPONSOR*_*`, the REGISTRAR pair (Main; the
   viewing key MUST be the derived account-0 value, see the example's note),
   fresh ENCRYPTION_KEY. Add `TRY_DOMAIN=demo.<your-domain>` to
   `deploy/.env`; scp `.env.demo` to the server (gitignored, mode 600).
4. **Caddy**: `cp Caddyfile.demo Caddyfile` on the server (adds the demo
   site), then `docker compose restart caddy`.
5. **Fresh DB on the preview -> preprod switch**: the old demo data (preview
   testers/runs/wallet sync states) is dead weight on preprod. Stop the demo
   container and drop its data volume once:
   `docker compose --profile demo down nightpass-demo && docker volume rm deploy_passport-demo-pg-data`.
   The next boot deploys a fresh schema (0.10.1 incl. `accountIndex`).
6. **Start + seed the sponsor sync states**: a fresh server DB would cold-sync
   every pool wallet for hours on preprod. Instead, carry the warm states over
   from the dev machine (blobs are keyed to each wallet's viewing key, so they
   restore as-is):
   ```bash
   node scripts/zz-export-syncstates.mjs                 # dev machine -> syncstates.json
   scp syncstates.json root@<server>:/root/nightpass/
   docker compose --profile demo up -d --build           # first boot creates the schema
   docker compose --profile demo cp ../syncstates.json nightpass-demo:/tmp/
   docker compose --profile demo exec nightpass-demo node scripts/zz-import-syncstates.mjs /tmp/syncstates.json
   docker compose --profile demo restart nightpass-demo  # boot prewarm now restores warm
   rm ../syncstates.json                                 # and delete the local copy too
   ```
   Then check `https://demo.<your-domain>/api/v1/demo/demoInfo()` shows
   `"enabled": true` and the landing's battery gauge fills up as the pool
   reports ready.
7. **Smoke**: run one visitor flow from a phone. Expect the register step
   with its own tx, ONE batched anchor tx, the proof tx, and a working
   explorer link on the done view (auto-verify green on the detail page).

Ops notes: the demo DB volume is disposable (visitor data only); caps are
env-tunable in `.env.demo`; the sponsor wallet is intentionally small, and
rotating it means running the setup script again + updating `.env.demo`.

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
chmod +x /root/nightpass/deploy/demo-restart.sh
( crontab -l 2>/dev/null | grep -v demo-restart.sh; \
  echo "17 5 * * * /root/nightpass/deploy/demo-restart.sh >> /root/nightpass-demo-restart.log 2>&1" ) | crontab -
```

Check runs with `tail -20 /root/nightpass-demo-restart.log` (expect
`prewarm CAUGHT UP lines: 3`).

On top of the nightly restart, `demo-autoheal.sh` recovers from a dead or
wedged container within 5 minutes: the compose file gives `nightpass-demo` a
healthcheck (node-fetch on demoInfo), and the script force-recreates the
container when it is not running or unhealthy. Docker's restart policy alone
does not cover either case (it ignores health, and a wedged process can
survive `docker restart` with "did not receive an exit event", which is how
the 2026-08-02 outage happened). Install as a 5-minute cron:

```bash
( crontab -l 2>/dev/null | grep -v demo-autoheal.sh; \
  echo "*/5 * * * * bash /root/nightpass/deploy/demo-autoheal.sh >> /root/nightpass-demo-autoheal.log 2>&1" ) | crontab -
```

The log stays empty while everything is healthy. Kill switch: the demo stays
down only if you also `touch /root/nightpass/deploy/.demo-off` before
`docker compose stop nightpass-demo` (otherwise autoheal resurrects it);
remove the file to re-enable.
