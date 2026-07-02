import cds from '@sap/cds';
import QRCode from 'qrcode';

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
