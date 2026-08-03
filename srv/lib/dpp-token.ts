/**
 * Credentials for the DPP conformance harness (pure).
 *
 * Tokens are self-describing (`bp.<role>.<uuid>.<sig>`) so a restart between
 * the executor's TestSetup and the scenario run does not invalidate them. The
 * signature is what makes that safe: without it, any string shaped like
 * `bp.authority.x` granted that role.
 *
 * Kept separate from dpp-api.ts on purpose: that module builds an express
 * router and pulls in the whole conformance surface, this one is a handful of
 * pure functions that can be unit-tested on their own.
 */

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Secret behind the signed tokens. Set DPP_API_TOKEN_SECRET to keep issued
 * tokens valid across a restart; otherwise a per-process secret is used and a
 * restart invalidates them (safe default, the executor re-issues via TestSetup).
 */
const TOKEN_SECRET = process.env.DPP_API_TOKEN_SECRET?.trim() || randomUUID();

function signTokenBody(body: string): string {
    return createHmac('sha256', TOKEN_SECRET).update(body).digest('hex').slice(0, 32);
}

/** Mint `bp.<role>.<uuid>.<sig>`. */
export function mintDppToken(role: string): string {
    const body = `bp.${role}.${randomUUID()}`;
    return `${body}.${signTokenBody(body)}`;
}

/**
 * The role a signed token carries, or undefined when it is unsigned, tampered
 * with or shaped like a token but not issued by us. Constant-time compare so
 * the signature cannot be brute-forced byte by byte.
 */
export function roleFromSignedToken(raw: string): string | undefined {
    const m = /^(bp\.([a-z_]+)\.[0-9a-f-]+)\.([0-9a-f]{32})$/.exec(raw);
    if (!m) return undefined;
    const expected = Buffer.from(signTokenBody(m[1]), 'utf8');
    const given = Buffer.from(m[3], 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return m[2];
}
