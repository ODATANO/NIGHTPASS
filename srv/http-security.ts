/**
 * NIGHTPASS HTTP security policy: UI5 CSP, CORS for the connector routes,
 * HSTS in production. The env switches are read on every request.
 */
import { createHttpSecurity, type HttpSecurityOptions, type RequestLike, type ResponseLike } from '@odatano/dpp-sdk/http';

const DEFAULT_CSP = [
    "default-src 'self' https://ui5.sap.com",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://ui5.sap.com",
    "style-src 'self' 'unsafe-inline' https://ui5.sap.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://ui5.sap.com",
    "connect-src 'self' ws: wss: https://ui5.sap.com http://localhost:* https://*.midnight.network",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
].join('; ');

function securityOptions(env: NodeJS.ProcessEnv): HttpSecurityOptions {
    const corsApi = env.PASSPORT_CORS_API === 'true';
    const csp = env.PASSPORT_CONTENT_SECURITY_POLICY;
    const hstsOn = env.NODE_ENV === 'production' && env.PASSPORT_HSTS !== 'off';
    return {
        corsOrigins: (env.PASSPORT_CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
        corsPaths: (p) => p === '/contract-manifest' || p.startsWith('/zk-config/') || (corsApi && p.startsWith('/api/v1/')),
        corsMethods: (p) => (p.startsWith('/api/v1/') ? 'GET, POST' : 'GET'),
        csp: csp === 'off' ? false : (csp || DEFAULT_CSP),
        hsts: hstsOn ? (env.PASSPORT_HSTS || 'max-age=31536000') : false,
    };
}

export function passportHttpSecurity(req: RequestLike, res: ResponseLike, next: () => void): void {
    createHttpSecurity(securityOptions(process.env))(req, res, next);
}
