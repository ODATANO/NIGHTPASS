/**
 * Server-side conformance check against the official BatteryPass-Ready
 * validation API (batterypass-ready.gefeg.com). Runs from the cockpit BEFORE
 * anchoring: the browser calls the producer action, the server holds the API
 * key and proxies the ValidateJSON call, so the secret never reaches the client.
 *
 * The guide document is built from the passport rows via buildGuideDocument
 * (srv/lib/guide-document.ts), the same shape that validated zero-error on
 * 2026-07-17.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGuideDocument, PassportRow, BatteryRow, RecycledRow, AttributeRow } from './guide-document';

const VALIDATE_URL = 'https://batterypass-ready.gefeg.com/automation-console/api/ValidateJSON';
const TOKEN_URL = 'https://batterypass-ready.gefeg.com/auth/realms/batterypass/protocol/openid-connect/token';
const TOKEN_FILE = resolve(__dirname, '../../secrets/batterypass-ready-token.json');

/** BP-Ready validation guide per battery category (schemas from GetSchemas). */
const GUIDE_BY_CATEGORY: Record<string, string> = {
    EV: 'EV_Guide',
    LMT: 'LMT_Guide',
    INDUSTRIAL: 'Other_Industrial_2kWh_Guide',
};

export interface ConformanceIssue { path: string; message: string }
export interface ConformanceResult {
    valid: boolean;
    guide: string | null;
    errorCount: number;
    issues: ConformanceIssue[];
    checkedAt: string;
    error?: string; // set only on transport/config failure (not on validation errors)
}

// The automation-console (ValidateJSON) accepts ONLY a Keycloak Bearer token,
// not the X-Api-Key (that one is for the test-executor). The offline refresh
// token in secrets/batterypass-ready-token.json does not expire, so the server
// refreshes an access token headlessly. Access tokens live 5 min; cache one.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string | null> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;
    let refresh: string;
    try {
        refresh = JSON.parse(readFileSync(TOKEN_FILE, 'utf8')).refresh_token;
        if (!refresh) return null;
    } catch { return null; }
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'batterypass-ui', refresh_token: refresh }),
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) return null;
        const j: any = await res.json();
        cachedToken = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 300) * 1000 };
        return cachedToken.value;
    } catch { return null; }
}

/** Parse the <Errors> list out of the validator's validationLogXml. */
function parseIssues(validationLogXml: string): ConformanceIssue[] {
    const issues: ConformanceIssue[] = [];
    // Each error is an <Error ...> block with <XPath> and <Message> children.
    const blocks = validationLogXml.match(/<Error\b[\s\S]*?<\/Error>/g) ?? [];
    for (const b of blocks) {
        const path = (b.match(/<XPath>([\s\S]*?)<\/XPath>/)?.[1] ?? '').trim();
        const message = (b.match(/<Message>([\s\S]*?)<\/Message>/)?.[1] ?? '').trim()
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        if (message) issues.push({ path, message });
    }
    return issues;
}

export async function validateConformance(
    passport: PassportRow & { batteryCategory?: string | null },
    batteries: BatteryRow[], recycled: RecycledRow[], attrs: AttributeRow[],
): Promise<ConformanceResult> {
    const checkedAt = new Date().toISOString();
    const guide = GUIDE_BY_CATEGORY[passport.batteryCategory ?? ''] ?? 'EV_Guide';
    const token = await accessToken();
    if (!token) {
        return { valid: false, guide, errorCount: 0, issues: [], checkedAt,
            error: 'No BatteryPass-Ready session (secrets/batterypass-ready-token.json missing or refresh token expired).' };
    }

    const doc = buildGuideDocument(passport, batteries, recycled, attrs);
    // Empty variant must be the literal string "" (%22%22); param is `tag`.
    const url = `${VALIDATE_URL}?tag=${encodeURIComponent(guide)}&version=1.0&variant=%22%22&language=en`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
            body: JSON.stringify(doc),
            signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
            return { valid: false, guide, errorCount: 0, issues: [], checkedAt,
                error: `Validator returned HTTP ${res.status}` };
        }
        const body: any = await res.json();
        const issues = parseIssues(String(body?.validationLogXml ?? ''));
        return { valid: issues.length === 0, guide, errorCount: issues.length, issues, checkedAt };
    } catch (e: any) {
        return { valid: false, guide, errorCount: 0, issues: [], checkedAt,
            error: `Validator unreachable: ${e?.message ?? e}` };
    }
}
