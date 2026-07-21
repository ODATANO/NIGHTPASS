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
   node scripts/bake-demo-db.mjs                                 # sanitized deploy/passport-demo.db
   cp deploy/.env.example deploy/.env                            # then fill it in
   ```
   Fill `deploy/.env`: domain, ENCRYPTION_KEY (same as local .env), strong
   DEMO_PASS_* values.

3. **Server prep**: install Docker (`curl -fsSL https://get.docker.com | sh`),
   then copy the repo onto the server (`git clone` + copy `deploy/.env` and
   `deploy/passport-demo.db` over, they are gitignored).

4. **Seed the volume, then start** (from the repo root on the server):
   ```bash
   cd deploy
   docker compose create nightpass
   docker compose run --rm --entrypoint sh nightpass -c "cp /src/passport-demo.db /data/passport.db" \
     || docker run --rm -v deploy_passport-db:/data -v $(pwd):/src alpine cp /src/passport-demo.db /data/passport.db
   docker compose up -d
   ```

5. **Smoke check** from anywhere:
   - `https://passport.<your-domain>/explorer/` shows the passports, "Verify all" turns green
   - `https://passport.<your-domain>/p/BAT-FRESH-20260717125619` resolves a QR scan into the consumer view
   - `https://passport.<your-domain>/api/v1/passport/verifyOnChain(passportId='BAT-FRESH-20260717125619')`
     returns `"verified": true` (first call cold ~30-60s, then seconds)

## Notes

- `deploy/.env` and `deploy/passport-demo.db` are gitignored; move them to the
  server via scp, never commit them.
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

1. **DNS**: A record for `demo.<your-domain>` (the wildcard already covers it
   on zkpassport.eu).
2. **Sponsor wallet** (dev machine): `scripts/zz-demo-sponsor-setup.mjs`
   creates + funds the dedicated sponsor (1000 tNIGHT from Main, dust
   registered) and stores its secrets as `DEMO_SPONSOR_*` in
   `secrets/producer-wallets.env`.
3. **Config**: `cp deploy/.env.demo.example deploy/.env.demo`, fill it from
   the `DEMO_SPONSOR_*` values; add `TRY_DOMAIN=demo.<your-domain>` to
   `deploy/.env`; scp `.env.demo` to the server (gitignored).
4. **Caddy**: `cp Caddyfile.demo Caddyfile` on the server (adds the demo
   site), then `docker compose restart caddy`.
5. **Start**: `docker compose --profile demo up -d --build`. First boot
   deploys a fresh scratch DB into `passport-demo-db` and prewarms the
   sponsor (~1 min); check `https://demo.<your-domain>/api/v1/demo/demoInfo()`
   shows `"enabled": true`.
6. **Smoke**: run one visitor flow from a phone; the finished passport must
   appear on the MAIN explorer (publish/ingest path) with its ZK claim.

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
