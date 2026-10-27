# NIGHTPASS public demo

One container (`nightpass-demo`) serves both public surfaces:

- the explorer on the main domain (`zkpassport.eu`, opens on `/explorer/`):
  passports, QR resolver and anonymous on-chain verification;
- the "Try it" demo under `/demo/` (also reachable as `demo.zkpassport.eu`),
  where visitors anchor their own passport (battery or component) on preprod.

Next to it run an internal `proof-server`, a private PostgreSQL and Caddy for
automatic TLS. Background and hardening details: `docs/public-demo.md`.

The demo runs on the REMOTE transport: the container holds no wallet and no
NIGHT. Each run derives a throwaway seed, builds and proves its transactions
locally (`@odatano/nightgate-tx`, proving on the internal proof-server) and
hands the fee-unpaid bytes to the hosted NIGHTGATE (`api.nightgate.dev`,
service paths `/odata/v4/midnight*`) under an agent grant; the hosted sponsor
pool pays the dust. Per run: attest + anchorContentRoot + bindDocument (one
batch), the claim cart (one batch), optionally the second-life re-anchor
(battery only). Verification reads go through the public verify service
(`/odata/v4/midnight-verify`) without a token. Runs start immediately (no
wallet sync).

## Setup

1. **DNS**: A records for the main domain and the demo subdomain, pointing at
   the server's IPv4. Do this first; Caddy needs the records live to obtain
   the certificates.

2. **Hosted side** (operator of the NIGHTGATE API): the demo vault in the
   sponsor policy (`allowedContracts` + `bindDocument` in `allowedCircuits`),
   then `createAgentGrant(allowedActions: ['sponsorUnboundTransaction'],
   sponsorSessionId: <pool sentinel>, allowedContracts: [<vault>],
   allowedCircuits: [attest, bindDocument, anchorContentRoot,
   proveFieldPredicate, proveFieldMembership], maxJobsPerDay: <DEMO_MAX_PER_DAY x 4>,
   agentLabel: 'nightpass-demo')`. The token is shown once. The vault must be
   the lineage the hosted API and the installed `@odatano/nightgate-tx` build
   calls for (lineage 4); a grant from an earlier lineage lists `bindPassport`
   and refuses the new circuit name.

3. **Config** (both files are gitignored; scp them to the server, mode 600):
   - `cp deploy/.env.example deploy/.env`: domains and `POSTGRES_PASSWORD`.
   - `cp deploy/.env.demo.example deploy/.env.demo`:
     `DEMO_NIGHTGATE_AGENT_TOKEN`, `PASSPORT_CONTRACT_ADDRESS` (the vault from
     step 2), a fresh `ENCRYPTION_KEY` (payload cipher + tester seeds at rest).

4. **Server prep**: install Docker (`curl -fsSL https://get.docker.com | sh`),
   then lay the repo down on the server (`git archive HEAD | ssh <host> tar -x
   -C /root/nightpass`) and copy both env files into `deploy/`.

5. **Schema, then start**: deploy the schema as a one-off so a slow
   `cds.deploy` can never eat the healthcheck window, then start:
   ```bash
   cd deploy
   docker compose build nightpass-demo
   docker compose run --rm --no-deps nightpass-demo npm run deploy
   docker compose up -d
   ```
   The first boot fetches the prover keys from the hosted `/zk-config` into
   the `passport-demo-zk-cache` volume (`remote lane zk assets ready` in the
   log); later boots find them cached.

6. **Smoke**:
   - `https://<main-domain>/` redirects to `/explorer/`, "Verify all" turns green
   - `https://<main-domain>/api/v1/demo/demoInfo()` shows `"enabled": true`;
     `demoProfiles()` lists both families
   - run one visitor flow per family from a phone. Expect two anchor txs
     (attest, then root + bind), ONE proof tx for all picked claims, and on
     the done view the QR that resolves to the passport in the explorer. On
     the hosted side the grant's `jobsUsed` grows by 3 per run (4 with the
     battery second-life act).

## Updates

```bash
git archive HEAD | ssh <host> tar -x -C /root/nightpass
ssh <host> 'cd /root/nightpass/deploy && docker compose up -d --build nightpass-demo'
```

A schema change needs the one-off `npm run deploy` from step 5 before `up`.
The demo DB is disposable (visitor data only).

## Notes

- The DPP conformance API stays OFF on public hosts (`DPP_API_ENABLED` unset);
  it is a test surface with unauthenticated writes by design.
- Caps are env-tunable in `.env.demo`; the second line of defence is the
  grant's `maxJobsPerDay` on the hosted side. Rotating the token means a new
  grant (`revokeAgentGrant` the old one) and a container restart.
- `DEMO_MAINTENANCE=true` in `.env.demo` parks the demo behind a static page
  without a redeploy; the explorer keeps serving.
- Fallback: `DEMO_TRANSPORT=plugin` keeps the in-process lane (server wallets,
  sponsor pool, `mem_limit` 12g); the wallet and sponsor keys in the example
  file document that profile.

### Periodic restart (stale sponsor sessions)

Over long uptime (~30h+) the indexer websockets drop (`Wallet.Sync:
[object CloseEvent]` in the logs) and the boot-prewarmed sponsor-pool
sessions go inactive, so every anchor then fails with `Sponsor session not
found, inactive, or not usable by this caller` while `startTester` /
`createDemoPassport` still succeed. `demo-restart.sh` pre-empts this: it
waits out any in-flight visitor run (up to 3 x 10 min), restarts the
`nightpass-demo` container and logs the sponsor prewarm result. Install as a
daily cron on the server:

```bash
( crontab -l 2>/dev/null | grep -v demo-restart.sh; \
  echo "17 5 * * * bash /root/nightpass/deploy/demo-restart.sh >> /root/nightpass-demo-restart.log 2>&1" ) | crontab -
```

The `bash` prefix is deliberate: a deploy that lays the repo down as a tar can
drop the exec bit, and a cron line calling the path directly then dies with
"Permission denied".

Check runs with `tail -20 /root/nightpass-demo-restart.log` (expect
`prewarm CAUGHT UP lines: 3`).

### Auto-heal

`autoheal.sh nightpass-demo` recovers a dead or wedged container within 5
minutes. The container carries a compose healthcheck (a node-fetch against its
own anonymous endpoint), and the script force-recreates it when it is not
running or reports unhealthy. Docker's restart policy covers neither case: it
ignores health, and a wedged process can survive `docker restart` with "did
not receive an exit event".

```bash
( crontab -l 2>/dev/null | grep -v autoheal.sh; \
  echo "*/5 * * * * bash /root/nightpass/deploy/autoheal.sh nightpass-demo >> /root/nightpass-autoheal.log 2>&1" ) | crontab -
```

The log stays empty while everything is healthy. Auto-heal and the nightly
restart take the same `flock`, so they cannot fight over the container.

**Kill switch:** a plain `docker compose stop` is undone within 5 minutes.
To keep the container down, `touch /root/nightpass/deploy/.nightpass-demo-off`
first and remove the file to re-enable.

### Database backups

`backup-db.sh` dumps the database (`pg_dump -Fc`, restore with `pg_restore`)
and prunes dumps older than `RETAIN_DAYS` (default 14):

```bash
( crontab -l 2>/dev/null | grep -v backup-db.sh; \
  echo "23 3 * * * bash /root/nightpass/deploy/backup-db.sh >> /root/nightpass-backup.log 2>&1" ) | crontab -
```

Set `OFFSITE_CMD` in the cron line (for example an `rclone copy`) to ship the
dumps off the box; on their own they survive an accidental delete but not a
host loss.

### Key material

A database dump is NOT a full backup. `deploy/.env.demo` holds the agent token
and the `ENCRYPTION_KEY`, and without the matching key every `payloadCipher`
in a restored dump stays unreadable forever. Keep an encrypted copy of both
env files somewhere that is not this server.
