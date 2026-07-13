# Public demo deployment

How to put the NIGHTPASS passport viewer on a public host so that visitors of
your homepage can open a battery passport from its QR code and verify it live
against the Midnight ledger, without any account.

## What visitors get

1. Your homepage links (or embeds the QR image of) `https://<demo-host>/p/<passportId>`.
2. The resolver routes them into the SAPUI5 viewer at the consumer tier
   (Annex XIII Point 1 fields only). Recycler/authority stay behind login.
3. The detail panel has a **Verify on Midnight** button. It calls the anonymous
   `PassportService.verifyOnChain(passportId)` function, which asks the public
   Midnight indexer live (crawler-free, NIGHTGATE `verifyAttestationState`)
   whether the passport's payload hash is anchored in the attestation vault.
   This is a real ledger read at click time, not a database flag, so a passport
   anchored minutes earlier in a live demo verifies immediately.
4. An explorer link to the attestation transaction is shown as an independent
   second proof.

The verify path needs NO wallet, NO proof server and NO signing material on the
server: it is a read against `https://indexer.<network>.midnight.network`.

**Networks.** Each passport row stores the network it was anchored on
(`anchorNetwork`, e.g. `preview` or `preprod`). Rows anchored on a DIFFERENT
network than the host's `NIGHTGATE_NETWORK` can be live-verified in two ways:

The **explorer list** shows one network per instance by design; run one
instance per network and cross-link them via `PASSPORT_EXPLORER_LINKS`. Both
instances share the database volume, so a passport anchored on either network
appears on its network's explorer. An instance whose explorer is public needs
the full hardening (strong `DEMO_PASS_*`); an instance that only serves as a
verify peer can stay unpublished.

**Detail deep links** (a QR of a preprod passport opened on the preview host)
can still live-verify across networks in two ways:

1. **Peer delegation (works today):**
   `PASSPORT_VERIFY_PEERS=preprod=http://nightpass-preprod:4004` makes
   `verifyOnChain` delegate cross-network checks to the sibling instance
   SERVER-SIDE over its public API (no CORS/CSP impact, the browser only ever
   talks to the instance it is on). The peer's FIRST state read builds its
   provider bundle and can take ~30-60s cold; warm verifies answer in seconds.
2. **NIGHTGATE `network` override (single process, pending):** once the FR
   `verify-state-network-override.md` ships, NIGHTPASS detects it automatically
   (`runtime-config.crossNetworkVerify: true`) and the peer delegation becomes
   unnecessary.

Without either, a cross-network detail shows "anchored on <network>" with the
verify button disabled and links the transaction on that network's explorer
instead.

## Recommended topology: public explorer + private producer instances

The cleanest public setup separates surfaces, not repos: **every producer runs
their own (internal) NIGHTPASS work instance**, and one **public explorer
instance** aggregates and shows them all. QR codes printed on batteries point
at the public explorer, whose detail page shows the Point-1 info and verifies
the anchor live against the chain.

Public explorer instance (same image, three env vars):

| Variable | Effect |
|---|---|
| `PASSPORT_PUBLIC_SURFACE=explorer` | serves ONLY `/explorer`, GET `/api/v1/passport/*`, `/qr`, `/p`, `/resolve`; everything else (cockpit, tiered viewer, webhook, all writes) answers 404. `/p/<id>` (the QR target) redirects to the explorer detail page. |
| `PASSPORT_SOURCES=cellco=https://cellco.internal,acme=...` | federation: pulls each producer's anonymous `anchorExplorer()` (public Point-1 + anchor metadata) into the local DB every `PASSPORT_SYNC_INTERVAL_MS` (default 60s). The vault map is deliberately not enumerable on-chain, so this pull is what populates the cross-producer view; verification never trusts it and always re-reads the chain. |
| `PASSPORT_VIEWER_BASE` | optional link target for "Open in Passport Viewer" (an internal work instance); unset on the explorer surface = link hidden. |

The explorer instance needs NO wallet, no proof server, no producer secrets and
its OWN (fresh) database; producers set `PASSPORT_DEMO_HOST` to the public
explorer host so their QR codes resolve there. The producer work instances stay
internal (SAP BTP, VPN, ...) and expose at most their anonymous GET read API to
the explorer.

## Two deployment modes

### A. Read-only viewer + verifier (recommended default)

Serve pre-anchored passports; nothing on the host can write to the chain.

Required env:

| Variable | Value |
|---|---|
| `ENCRYPTION_KEY` | 32-byte hex (required with `NODE_ENV=production`) |
| `PASSPORT_DEMO_HOST` | `https://<demo-host>` (canonical QR URL host) |
| `PASSPORT_CONTRACT_ADDRESS` | your deployed attestation-vault address |
| `DEMO_PASS_PRODUCER` | strong secret (MUST be set publicly) |
| `DEMO_PASS_AUTHORITY` | strong secret (MUST be set publicly) |
| `DEMO_PASS_RECYCLER` | strong secret (MUST be set publicly) |

Do NOT set on this mode: `LACE_*`, `PRODUCER_*`, `ERP_WEBHOOK_SECRET`. Without
them the server cannot sign or ingest anything; anchoring actions fail cleanly.

### B. Live-create demo (create + anchor during the presentation)

Same as A, plus the server signing wallet and a proof server, so the presenter
(logged in as `producer`) or the EQUINOX agent (via the ERP webhook) can create
a passport during the demo and the audience verifies it seconds later:

| Variable | Value |
|---|---|
| `PRODUCER_WALLET_MNEMONIC` or `PRODUCER_WALLET_SEED_HEX` | testnet wallet with tDUST |
| `PRODUCER_VIEWING_KEY` | matching viewing key |
| `NIGHTGATE_PROOF_SERVER_URL` | `http://proof-server:6300` (the sidecar below) |
| `ERP_WEBHOOK_SECRET` | only if the EQUINOX webhook should be reachable |

The proof server runs as a sidecar next to the app (it needs no secrets):

```yaml
# docker-compose.yml (mode B; drop proof-server and the PRODUCER_* env for
# mode A). One explorer instance per network, cross-linked; put a reverse
# proxy in front that maps preview.<host> -> :4004 and preprod.<host> -> :4005.
services:
  nightpass-preview:
    build: .
    ports: ["4004:4004"]
    env_file: .env.public          # NIGHTGATE_NETWORK=preview, DEMO_PASS_*
    environment:
      PASSPORT_VERIFY_PEERS: preprod=http://nightpass-preprod:4004
      PASSPORT_EXPLORER_LINKS: preprod=https://preprod.<demo-host>/explorer/
    volumes: ["passport-db:/data"]
  nightpass-preprod:
    build: .
    ports: ["4005:4004"]
    env_file: .env.public          # same hardening: this instance is public too
    environment:
      NIGHTGATE_NETWORK: preprod
      PASSPORT_VERIFY_PEERS: preview=http://nightpass-preview:4004
      PASSPORT_EXPLORER_LINKS: preview=https://preview.<demo-host>/explorer/
    volumes: ["passport-db:/data"]
  proof-server:
    image: midnightnetwork/proof-server:latest
    command: ["midnight-proof-server", "--port", "6300"]
volumes:
  passport-db:
```

Only testnet (preview) funds belong on that wallet. Treat the host as
compromised by default and fund it accordingly.

## Build and run

```bash
docker build -t nightpass-demo .
docker run -d --name nightpass -p 4004:4004 \
  --env-file .env.public \
  -v passport-db:/data \
  nightpass-demo
```

The database lives at `/data/passport.db` inside the container (NOT `/app/db`:
mounting there would shadow the CDS model files).

The container deploys a fresh schema + CSV seeds on first start when the volume
is empty. To ship your already-anchored demo passports instead, copy a
sanitized database into the volume BEFORE the first start:

```bash
# sanitize: drop runtime wallet state, it does not belong on a public host
cp db/passport.db /tmp/passport.db
sqlite3 /tmp/passport.db "DELETE FROM midnight_WalletSyncStates; DELETE FROM midnight_WalletSessions;"
docker run --rm -v passport-db:/data -v /tmp:/src alpine cp /src/passport.db /data/passport.db
```

Put a TLS reverse proxy (Caddy, nginx, Cloudflare) in front of port 4004; QR
scans from phones need HTTPS anyway.

For a quick rehearsal without deploying anywhere, a Cloudflare tunnel from the
dev machine works too: `cloudflared tunnel --url http://localhost:4004` and use
the printed URL as `PASSPORT_DEMO_HOST`.

## Homepage integration

- Per passport, link `https://<demo-host>/p/<passportId>` and/or embed the QR
  image `https://<demo-host>/qr/<passportId>.png` directly (it encodes the
  resolver URL of the host it is served from).
- **Passport Explorer** (standalone, block-explorer style): link
  `https://<demo-host>/explorer/` for the public explorer app in the spirit of
  Cardanoscan / the Midnight explorer: search (passport ID, payload hash or
  attestation tx), stat tiles, the anchor table with per-row live verification
  and a "Verify all" sweep, and detail pages that verify automatically on open
  and offer the QR, viewer link and credential download. Dark theme, no login,
  no build step (`app/explorer/`, plain HTML/CSS/JS).
  **One instance = one network:** the list shows only the instance's own
  network (drafts are omitted). Each network gets its own instance and its own
  URL (e.g. `https://preview.<demo-host>/explorer/` and
  `https://preprod.<demo-host>/explorer/`); `PASSPORT_EXPLORER_LINKS` renders
  the switch links between them in the header and the stat tiles.
  The motion layer (hero anchor ring, staggered entrances, checkmark drawing)
  uses anime.js, vendored same-origin at `app/explorer/vendor/anime.esm.js`
  (`npm run vendor:explorer`, part of postinstall) because the CSP allows no
  third-party CDN. Purely progressive enhancement: a missing library or
  `prefers-reduced-motion` yields the same app without animations.
- The same overview also exists inside the SAPUI5 viewer at
  `.../passport/webapp/index.html#/explorer`. The underlying data is the
  anonymous `anchorExplorer()` function (`/api/v1/passport/anchorExplorer()`),
  usable directly from your homepage too if you prefer rendering your own list.
- Suppliers holding only the on-chain payload hash resolve via
  `https://<demo-host>/resolve/<payloadHash>`.
- The verifiable credential JSON is at
  `/api/v1/passport/passportCredential(payloadHash='<hash>')`.
- Prefer linking over iframing: the viewer is a full SAPUI5 app and the plugin
  CSP is not tuned for cross-origin framing.

## Security checklist before going public

- [ ] `DEMO_PASS_PRODUCER` / `DEMO_PASS_AUTHORITY` / `DEMO_PASS_RECYCLER` set
      (defaults equal the user names and are public knowledge).
- [ ] `ENCRYPTION_KEY` is a fresh random 32-byte hex, not the dev default.
- [ ] Mode A: no `LACE_*` / `PRODUCER_*` / `ERP_WEBHOOK_SECRET` on the host.
- [ ] Database in the image/volume is sanitized (no `midnight_WalletSyncStates`
      / `midnight_WalletSessions` rows from live runs).
- [ ] Page labels the demo as Midnight testnet (preview); a network reset
      requires re-anchoring.
- [ ] Write actions are producer-gated: `generatePassport`, `registerPartner`,
      `triggerGoodsReceipt` and the whole ProducerService reject anonymous
      callers. `verifyOnChain`, the viewer entities and the credential export
      are deliberately public.
