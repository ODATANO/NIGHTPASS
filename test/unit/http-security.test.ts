import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { passportHttpSecurity } from '../../srv/http-security';

const ENV_KEYS = [
    'NODE_ENV',
    'PASSPORT_CONTENT_SECURITY_POLICY',
    'PASSPORT_CORS_API',
    'PASSPORT_CORS_ORIGINS',
    'PASSPORT_HSTS'
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function response() {
    const headers: Record<string, string> = {};
    return {
        headers,
        statusCode: 200,
        ended: false,
        setHeader(name: string, value: string) { headers[name] = value; },
        status(code: number) { this.statusCode = code; return this; },
        end() { this.ended = true; }
    };
}

describe('passportHttpSecurity', () => {
    it('sets host security headers but does not add CORS to unrelated routes', () => {
        const req: any = { method: 'GET', path: '/passport/webapp/index.html', headers: {} };
        const res = response();
        let nextCalled = false;

        passportHttpSecurity(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, true);
        assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
        assert.match(res.headers['Content-Security-Policy'], /https:\/\/ui5\.sap\.com/);
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
        assert.match(req.correlationId, /^[0-9a-f-]{36}$/i);
    });

    it('allows configured origins only on connector routes', () => {
        process.env.PASSPORT_CORS_ORIGINS = 'https://wallet.example';
        const req: any = {
            method: 'GET', path: '/contract-manifest',
            headers: { origin: 'https://wallet.example', 'x-correlation-id': 'request-42' }
        };
        const res = response();

        passportHttpSecurity(req, res, () => undefined);

        assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://wallet.example');
        assert.equal(res.headers.Vary, 'Origin');
        assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET');
        assert.equal(res.headers['X-Correlation-ID'], 'request-42');
    });

    it('rejects an unapproved connector preflight without swallowing unrelated OPTIONS', () => {
        process.env.PASSPORT_CORS_ORIGINS = 'https://wallet.example';
        const denied = response();
        passportHttpSecurity(
            { method: 'OPTIONS', path: '/zk-config/vault/keys/proof.prover', headers: { origin: 'https://evil.example' } },
            denied,
            () => assert.fail('connector preflight must be completed by the middleware')
        );
        assert.equal(denied.statusCode, 403);
        assert.equal(denied.ended, true);

        const unrelated = response();
        let nextCalled = false;
        passportHttpSecurity(
            { method: 'OPTIONS', path: '/orders', headers: { origin: 'https://evil.example' } },
            unrelated,
            () => { nextCalled = true; }
        );
        assert.equal(nextCalled, true);
        assert.equal(unrelated.ended, false);
    });
});

