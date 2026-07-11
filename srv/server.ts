import cds from '@sap/cds';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import express from 'express';

const { SELECT } = cds.ql;

/**
 * NIGHTPASS bootstrap extras (T23): the public QR landing resolver and the QR
 * image endpoint. Registered on the Express app before CAP's services so a
 * scanned QR resolves to the right disclosure tier.
 *
 * Flow: a battery's QR encodes `<host>/p/<passportId>`. Scanning it hits the
 * resolver, which picks a tier from the caller's auth (none → consumer) and
 * redirects into the SAPUI5 app at that tier's route, carrying the passportId
 * so the view preselects the battery.
 */
cds.on('bootstrap', (app: any) => {
    // --- Tier resolver: GET /p/:passportId -----------------------------------
    app.get('/p/:passportId', (req: any, res: any) => {
        const passportId = String(req.params.passportId || '');
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
        const indexerHttpUrl = process.env.NIGHTGATE_INDEXER_HTTP_URL?.trim() || cfg.indexerHttpUrl
            || `https://indexer.${network}.midnight.network/api/v4/graphql`;
        const indexerWsUrl = process.env.NIGHTGATE_INDEXER_WS_URL?.trim() || cfg.indexerWsUrl
            || `wss://indexer.${network}.midnight.network/api/v4/graphql/ws`;
        res.json({ network, indexerHttpUrl, indexerWsUrl });
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
