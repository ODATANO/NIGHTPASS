import cds from '@sap/cds';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import express from 'express';
import { verifyPeers, explorerLinks, passportSources } from './lib/passport-anchor';

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

/**
 * NIGHTPASS bootstrap extras: the public QR landing resolver and the QR
 * image endpoint. Registered on the Express app before CAP's services so a
 * scanned QR resolves to the right disclosure tier.
 *
 * Flow: a battery's QR encodes `<host>/p/<passportId>`. Scanning it hits the
 * resolver, which picks a tier from the caller's auth (none → consumer) and
 * redirects into the SAPUI5 app at that tier's route, carrying the passportId
 * so the view preselects the battery.
 */
cds.on('bootstrap', (app: any) => {
    // --- Public-surface gate (PASSPORT_PUBLIC_SURFACE=explorer) --------------
    // Deployment split: a PUBLIC instance serves ONLY the explorer surface
    // (static app + anonymous GET read API + QR/resolver); cockpit, tiered
    // viewer, webhook and every write stay on the internal work instance.
    // Registered on bootstrap, so it runs before CAP's static/OData middlewares.
    const surface = process.env.PASSPORT_PUBLIC_SURFACE?.trim() || '';
    if (surface === 'explorer') {
        app.use((req: any, res: any, next: any) => {
            const p = String(req.path || '');
            const allowed =
                p === '/' ||
                p.startsWith('/explorer') ||
                p.startsWith('/qr/') ||
                p.startsWith('/p/') ||
                p.startsWith('/resolve/') ||
                (p.startsWith('/api/v1/passport') && req.method === 'GET') ||
                // Publish ingest: producers push anchored passports to the
                // public explorer (secret-gated in the handler).
                (p === '/api/v1/passport/ingest' && req.method === 'POST') ||
                // Conformance surface stays reachable when explicitly enabled
                // (throwaway tunnel instances for the BatteryPass-Ready executor).
                (p.startsWith('/dpp-api') && process.env.DPP_API_ENABLED === 'true');
            if (!allowed) return res.status(404).json({ error: 'not on this surface' });
            next();
        });
        app.get('/', (_req: any, res: any) => res.redirect(302, '/explorer/'));
    }

    // --- BatteryPass-Ready conformance surface (DPP_API_ENABLED=true) --------
    // DPP Life Cycle API v1.1 + TestAdapter for the official test executor.
    // Off by default: it is a write-capable, in-memory test surface meant for
    // throwaway instances behind a tunnel, never for the work instance.
    if (process.env.DPP_API_ENABLED === 'true') {
        const { createDppApiRouter } = require('./lib/dpp-api');
        app.use('/dpp-api', createDppApiRouter());
        console.log('[dpp-api] BatteryPass-Ready conformance surface mounted at /dpp-api (v1 + adapter)');
    }

    // --- Per-passport OG preview image: GET /p/:passportId/og.png ------------
    // Declared before the resolver so Express matches the longer path first.
    app.get('/p/:passportId/og.png', async (req: any, res: any) => {
        const passportId = String(req.params.passportId || '');
        try {
            const row = await SELECT.one.from('passport.Passports')
                .columns('passportId', 'model', 'batteryCategory', 'anchorNetwork', 'attestationTxHash', 'status')
                .where({ passportId });
            if (!row) return res.status(404).end();
            const { renderOgPng } = require('./lib/og-image');
            const png = await renderOgPng(row);
            res.type('image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(png);
        } catch (e: any) {
            res.status(500).end(String(e?.message ?? e));
        }
    });

    // --- Tier resolver: GET /p/:passportId -----------------------------------
    app.get('/p/:passportId', async (req: any, res: any) => {
        const passportId = String(req.params.passportId || '');
        // On the public explorer surface the explorer detail IS the QR landing
        // (the tiered viewer lives on the internal instance). Served as a meta
        // page instead of a 302: link crawlers read the per-passport OG tags
        // (they run no JS), humans are redirected instantly by the inline
        // script. Work instances keep the plain 302 below (tier resolver).
        if (surface === 'explorer') {
            const target = `/explorer/#/p/${encodeURIComponent(passportId)}`;
            try {
                const row = await SELECT.one.from('passport.Passports')
                    .columns('passportId', 'model', 'batteryCategory', 'anchorNetwork', 'attestationTxHash', 'status')
                    .where({ passportId });
                if (row) {
                    const { ogMetaPage } = require('./lib/og-image');
                    const host = process.env.PASSPORT_DEMO_HOST || `${req.protocol}://${req.get('host')}`;
                    res.type('text/html');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    return res.end(ogMetaPage(row, host.replace(/\/+$/, ''), target));
                }
            } catch { /* fall through to the plain redirect */ }
            return res.redirect(302, target);
        }
        const tier = tierFromAuth(req.headers.authorization);
        // The consumer route's pattern is "" (the SPA default), so it lives at the
        // empty hash. `#/consumer` matches NO route and renders a blank page, so only
        // the protected tiers carry a hash segment. (manifest.json routing.routes.)
        const hash = tier === 'consumer' ? '' : `#/${tier}`;
        const target = `/passport/webapp/index.html?p=${encodeURIComponent(passportId)}${hash}`;
        res.redirect(302, target);
    });

    // --- QR image: GET /qr/:passportId.png -----------------------------------
    // Encodes the resolver URL on THIS host so the QR is reachable in a demo on
    // the same network (the canonical public URL uses PASSPORT_DEMO_HOST). Works
    // for seeded and generated passports alike, no stored image needed.
    app.get('/qr/:file', async (req: any, res: any) => {
        const passportId = String(req.params.file || '').replace(/\.png$/i, '');
        if (!passportId) return res.status(400).end();
        const host = `${req.protocol}://${req.get('host')}`;
        try {
            const png = await QRCode.toBuffer(`${host}/p/${passportId}`, { width: 320, margin: 1 });
            res.type('image/png');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.end(png);
        } catch (e: any) {
            res.status(500).end(String(e?.message ?? e));
        }
    });

    // --- Runtime config for the browser connector -----------------------------
    // Issue #2 (JAlbertCode): the wallet connector must anchor to the SAME
    // network as the server worker. This exposes the server's effective
    // NIGHTGATE network (same precedence as the plugin: env override first,
    // then cds.requires.nightgate.network) so the client derives instead of
    // hardcoding. Indexer URLs follow the same precedence with the public
    // per-network hosts as default.
    app.get('/api/v1/passport/runtime-config', (_req: any, res: any) => {
        const cfg: any = (cds.env as any).requires?.nightgate ?? {};
        const network = process.env.NIGHTGATE_NETWORK?.trim() || cfg.network || 'preview';
        const httpOverride = process.env.NIGHTGATE_INDEXER_HTTP_URL?.trim() || cfg.indexerHttpUrl;
        const indexerHttpUrl = httpOverride
            || `https://indexer.${network}.midnight.network/api/v4/graphql`;
        // NIGHTGATE derives the ws endpoint from an HTTP-only override (same
        // host/path, ws scheme, /ws suffix). Mirror that here so the browser
        // connector stays on the exact indexer the server worker uses.
        const indexerWsUrl = process.env.NIGHTGATE_INDEXER_WS_URL?.trim() || cfg.indexerWsUrl
            || (httpOverride
                ? httpOverride.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws'
                : `wss://indexer.${network}.midnight.network/api/v4/graphql/ws`);
        // Capability flags for the explorer UIs: can verifyOnChain live-check
        // rows anchored on ANOTHER network? `crossNetworkVerify` covers ANY
        // network when the installed NIGHTGATE exposes the `network` override
        // (detected on the loaded model);
        // `peerNetworks` lists networks covered by delegating peer instances
        // (PASSPORT_VERIFY_PEERS) until then.
        const crossNetworkVerify =
            !!((cds.model as any)?.definitions?.['NightgateService.verifyAttestationState']?.params?.network);
        const peerNetworks = Object.keys(verifyPeers());
        // Where "Open in Passport Viewer" should point: an explicit base URL
        // (internal work instance), same-origin ('') when the viewer is
        // co-hosted, or null on a pure explorer surface (link hidden).
        const viewerBase = process.env.PASSPORT_VIEWER_BASE?.trim()
            || (surface === 'explorer' ? null : '');
        res.json({
            network, indexerHttpUrl, indexerWsUrl, crossNetworkVerify, peerNetworks,
            // Browser-facing explorer URLs of the sibling per-network instances
            // (PASSPORT_EXPLORER_LINKS); the explorer header renders them as
            // network switch links.
            explorerLinks: explorerLinks(),
            surface,
            viewerBase
        });
    });

    // --- ERP event ingest: POST /api/v1/passport/erp-events ------------------
    // Inbound webhook for the EQUINOX agent (or any ERP-side event source).
    // Auth is the HMAC signature over the raw body (shared secret via
    // ERP_WEBHOOK_SECRET), not a CAP user: the sender is a machine, and the
    // handler runs createPassport privileged AFTER the signature check.
    // Idempotent on passportId. ERP_AUTO_ANCHOR=true additionally submits
    // on-chain via the server signing session (PRODUCER_* env), otherwise the
    // passport lands as an offline draft.
    app.post('/api/v1/passport/erp-events',
        express.raw({ type: ['application/cloudevents+json', 'application/json'], limit: '256kb' }),
        async (req: any, res: any) => {
            const secret = process.env.ERP_WEBHOOK_SECRET;
            if (!secret) return res.status(503).json({ error: 'erp ingest not configured (ERP_WEBHOOK_SECRET unset)' });

            const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
            const given = String(req.headers['x-equinox-signature'] ?? '');
            const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
            const a = Buffer.from(given), b = Buffer.from(expected);
            if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
                return res.status(401).json({ error: 'invalid or missing x-equinox-signature' });
            }

            let event: any;
            try { event = JSON.parse(raw.toString('utf8')); }
            catch { return res.status(400).json({ error: 'body is not JSON' }); }
            if (event?.type !== 'com.odatano.equinox.goodsreceipt.created' || typeof event?.data !== 'object') {
                return res.status(400).json({ error: `unsupported event type '${event?.type ?? ''}'` });
            }
            const passportId = String(event.data?.passportId ?? '').trim();
            if (!passportId) return res.status(400).json({ error: 'data.passportId is required' });

            try {
                const existing: any = await SELECT.one.from('passport.Passports').columns('ID').where({ passportId });
                if (existing) return res.status(200).json({ status: 'duplicate', passportId });

                const producer: any = await cds.connect.to('ProducerService');
                // A fixed technical user, NOT cds.User.privileged: NIGHTGATE's
                // auth hardening binds wallet sessions to the userId, and the
                // whole chain (connectWallet -> signing session -> anchor job
                // polls) must run under the SAME user or the session lookups
                // fail. Use 'producer' (the same principal as the HTTP cockpit
                // path) so the cached server signing session is shared instead
                // of colliding across principals.
                const erpUser = new (cds.User as any)({ id: 'producer', roles: ['producer'] });
                // Managed tx (callback form), NOT `.tx({user}).send(...)`: only a
                // managed tx commits and fires the request's 'succeeded' event,
                // which anchorRow uses to start the detached on-chain runner.
                // With the unmanaged form the passport row lands but the anchor
                // never starts (row stuck in 'anchoring').
                const result = await (producer as any).tx({ user: erpUser }, (tx: any) => tx.send('createPassport', {
                    passportJson: JSON.stringify(event.data),
                    submit: process.env.ERP_AUTO_ANCHOR === 'true'
                }));
                cds.log('erp-ingest').info(`event ${event.id ?? '?'} -> passport ${passportId} (${result?.mode})`);
                return res.status(201).json({ status: 'created', passportId, mode: result?.mode ?? 'offline' });
            } catch (e: any) {
                cds.log('erp-ingest').error('ingest failed:', e?.message ?? e);
                return res.status(500).json({ error: String(e?.message ?? e) });
            }
        });

    // --- Passport publish ingest: POST /api/v1/passport/ingest ---------------
    // A work instance PUSHES an anchored passport's public Point-1 fields here
    // after it is anchored (and validated). Bearer-secret gated (the payload is
    // already public, so a shared secret is enough — no HMAC needed). Upsert by
    // passportId. Verification never trusts this: verifyOnChain re-reads the
    // chain. Runs on the public read surface so producers can publish to it.
    const INGEST_FIELDS = [
        'model', 'manufacturerId', 'batteryCategory', 'manufactureDate', 'weightKg',
        'performanceClass', 'qrCodeUrl', 'payloadHash', 'contractAddress',
        'anchorNetwork', 'attestationTxHash', 'status',
    ] as const;
    app.post('/api/v1/passport/ingest', express.json({ limit: '256kb' }), async (req: any, res: any) => {
        const secret = process.env.PASSPORT_INGEST_SECRET;
        if (!secret) return res.status(503).json({ error: 'ingest not configured (PASSPORT_INGEST_SECRET unset)' });
        const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const a = Buffer.from(given), b = Buffer.from(secret);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(401).json({ error: 'invalid or missing bearer secret' });
        }
        const passportId = String(req.body?.passportId ?? '').trim();
        if (!passportId) return res.status(400).json({ error: 'passportId is required' });
        try {
            const data: Record<string, unknown> = {};
            for (const f of INGEST_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f];
            const existing: any = await SELECT.one.from('passport.Passports').columns('ID').where({ passportId });
            let ID = existing?.ID as string | undefined;
            if (ID) {
                await UPDATE.entity('passport.Passports').set(data).where({ ID });
            } else {
                ID = cds.utils.uuid();
                await INSERT.into('passport.Passports').entries({ ID, passportId, ...data });
            }
            // Proven ZK claims (claim + threshold + proof tx, no values): replace
            // this passport's rows so re-publishes stay idempotent. Thresholds
            // arrive in RAW units and are stored scaled (milli-units), the same
            // convention the local prove path uses.
            if (Array.isArray(req.body.claims)) {
                await DELETE.from('passport.PredicateProofLog').where({ passport_ID: ID });
                const rows = req.body.claims
                    .filter((c: any) => c && c.sourceField && (c.predicate === 'lessOrEqual' || c.predicate === 'greaterOrEqual'))
                    .map((c: any) => ({
                        ID: cds.utils.uuid(), passport_ID: ID,
                        sourceField: String(c.sourceField).slice(0, 120),
                        predicate: c.predicate,
                        threshold: Math.round(Number(c.threshold ?? 0) * 1000),
                        unit: String(c.unit ?? '').slice(0, 60),
                        txHash: String(c.txHash ?? '').slice(0, 120),
                        status: 'succeeded', result: true,
                        ...(c.provenAt ? { createdAt: c.provenAt } : {}),
                    }));
                if (rows.length) await INSERT.into('passport.PredicateProofLog').entries(rows);
            }
            cds.log('publish-ingest').info(`ingested passport ${passportId} (${data.status ?? '?'}, ${req.body.claims?.length ?? 0} claims)`);
            return res.status(existing ? 200 : 201).json({ status: existing ? 'updated' : 'created', passportId });
        } catch (e: any) {
            cds.log('publish-ingest').error('ingest failed:', e?.message ?? e);
            return res.status(500).json({ error: String(e?.message ?? e) });
        }
    });

    // --- Supplier resolve by on-chain hash: GET /resolve/:payloadHash --------
    // A supplier handed only the passport payloadHash resolves the exact battery:
    // look up its passportId and 302 into the tier-gated viewer (their disclosure
    // grant / role decides how much they see).
    app.get('/resolve/:payloadHash', async (req: any, res: any) => {
        const payloadHash = String(req.params.payloadHash || '').replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(payloadHash)) return res.status(400).end('invalid payloadHash');
        try {
            const row: any = await SELECT.one.from('passport.Passports').columns('passportId').where({ payloadHash });
            if (!row) return res.status(404).end('no battery for that payloadHash');
            const tier = tierFromAuth(req.headers.authorization);
            const hash = tier === 'consumer' ? '' : `#/${tier}`;
            return res.redirect(302, `/passport/webapp/index.html?p=${encodeURIComponent(row.passportId)}${hash}`);
        } catch (e: any) {
            return res.status(500).end(String(e?.message ?? e));
        }
    });
});

// --- Federation sync: aggregate anchors from producer instances ---------------
//
// A PUBLIC explorer instance shows passports of MANY producers. Each producer
// runs its own NIGHTPASS; PASSPORT_SOURCES lists their base URLs, and this loop
// periodically pulls each one's anonymous anchorExplorer() surface (public
// Point-1 fields + anchor metadata, nothing else exists there) into the local
// Passports table, keyed by passportId. Verification never trusts this data:
// verifyOnChain re-reads the vault state live from the chain indexer.
cds.on('served', () => {
    const sources = passportSources();
    const names = Object.keys(sources);
    if (!names.length) return;
    const log = cds.log('explorer-sync');
    const intervalMs = Math.max(15000, Number(process.env.PASSPORT_SYNC_INTERVAL_MS) || 60000);
    const FIELDS = [
        'model', 'manufacturerId', 'batteryCategory', 'manufactureDate', 'weightKg',
        'performanceClass', 'qrCodeUrl', 'payloadHash', 'contractAddress',
        'anchorNetwork', 'attestationTxHash', 'status'
    ] as const;

    async function syncOnce(): Promise<void> {
        for (const name of names) {
            try {
                const r = await fetch(`${sources[name]}/api/v1/passport/anchorExplorer()`,
                    { signal: AbortSignal.timeout(20000) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const rows: any[] = ((await r.json()) as any)?.value ?? [];
                let n = 0;
                for (const row of rows) {
                    const passportId = String(row?.passportId ?? '').trim();
                    if (!passportId) continue;
                    const data: Record<string, unknown> = {};
                    for (const f of FIELDS) if (row[f] !== undefined) data[f] = row[f];
                    const existing: any = await SELECT.one.from('passport.Passports')
                        .columns('ID').where({ passportId });
                    if (existing) {
                        await UPDATE.entity('passport.Passports').set(data).where({ ID: existing.ID });
                    } else {
                        await INSERT.into('passport.Passports')
                            .entries({ ID: cds.utils.uuid(), passportId, ...data });
                    }
                    n++;
                }
                log.info(`synced ${n} passports from '${name}' (${sources[name]})`);
            } catch (e: any) {
                log.warn(`source '${name}' unreachable:`, e?.message ?? e);
            }
        }
    }

    setTimeout(() => { void syncOnce(); }, 3000);
    const t = setInterval(() => { void syncOnce(); }, intervalMs);
    (t as any).unref?.();
    log.info(`aggregating ${names.length} producer source(s) every ${intervalMs}ms: ${names.join(', ')}`);
});

/**
 * Map an HTTP Basic auth header to a disclosure tier. The mocked users are
 * named after their role (see package.json). No / unknown credentials → public
 * consumer tier, exactly what a cold phone scan gets.
 */
function tierFromAuth(authHeader?: string): 'consumer' | 'recycler' | 'authority' {
    if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) return 'consumer';
    try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
        const user = decoded.split(':')[0];
        if (user === 'authority') return 'authority';
        if (user === 'recycler') return 'recycler';
    } catch { /* fall through */ }
    return 'consumer';
}
