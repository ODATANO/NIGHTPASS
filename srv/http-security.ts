import crypto from 'node:crypto';

const DEFAULT_CSP = [
    "default-src 'self' https://ui5.sap.com",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://ui5.sap.com",
    "style-src 'self' 'unsafe-inline' https://ui5.sap.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://ui5.sap.com",
    "connect-src 'self' ws: wss: https://ui5.sap.com http://localhost:* https://*.midnight.network",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
].join('; ');

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type RequestLike = {
    method?: string;
    path?: string;
    headers?: Record<string, string | string[] | undefined>;
    correlationId?: string;
};

type ResponseLike = {
    setHeader(name: string, value: string): void;
    status(code: number): ResponseLike;
    end(): void;
};

function configuredOrigins(): string[] {
    return (process.env.PASSPORT_CORS_ORIGINS ?? '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
}

function isCorsManagedPath(pathname: string): boolean {
    if (pathname === '/contract-manifest' || pathname.startsWith('/zk-config/')) return true;
    return process.env.PASSPORT_CORS_API === 'true' && pathname.startsWith('/api/v1/');
}

function allowedOrigin(origin: string | undefined, configured: string[]): string | undefined {
    if (!origin || configured.length === 0) return undefined;
    if (configured.includes('*')) return '*';
    return configured.includes(origin) ? origin : undefined;
}

function appendVaryOrigin(res: ResponseLike): void {
    // This middleware owns Vary for NIGHTPASS today. Keeping the helper
    // isolated makes it straightforward to merge an existing value later.
    res.setHeader('Vary', 'Origin');
}

/** Host-owned HTTP policy. NIGHTGATE intentionally installs none globally. */
export function passportHttpSecurity(req: RequestLike, res: ResponseLike, next: () => void): void {
    const headers = req.headers ?? {};
    const incomingCorrelation = Array.isArray(headers['x-correlation-id'])
        ? headers['x-correlation-id'][0]
        : headers['x-correlation-id'];
    const correlationId = incomingCorrelation && CORRELATION_ID.test(incomingCorrelation)
        ? incomingCorrelation
        : crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const configuredCsp = process.env.PASSPORT_CONTENT_SECURITY_POLICY;
    if (configuredCsp !== 'off') {
        res.setHeader('Content-Security-Policy', configuredCsp || DEFAULT_CSP);
    }
    if (process.env.NODE_ENV === 'production' && process.env.PASSPORT_HSTS !== 'off') {
        res.setHeader('Strict-Transport-Security', process.env.PASSPORT_HSTS || 'max-age=31536000');
    }

    const pathname = String(req.path ?? '');
    if (!isCorsManagedPath(pathname)) {
        next();
        return;
    }

    const requestOrigin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
    const allowOrigin = allowedOrigin(requestOrigin, configuredOrigins());
    if (allowOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowOrigin);
        if (allowOrigin !== '*') appendVaryOrigin(res);
        res.setHeader('Access-Control-Allow-Methods', pathname.startsWith('/api/v1/') ? 'GET, POST' : 'GET');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Correlation-ID');
        res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
        res.status(allowOrigin ? 204 : 403).end();
        return;
    }
    next();
}

