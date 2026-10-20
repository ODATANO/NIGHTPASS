/**
 * Pure input validation for the "Try it" demo (unit-testable, no CAP).
 *
 * Head text becomes PUBLIC explorer content, so the charset is deliberately
 * narrow; numbers are bounded to the catalog's plausible ranges. Every claim
 * must be TRUE: the demo's point is a succeeding proof, and the ledger would
 * reject a false one anyway, which reads as a confusing failure to a visitor.
 */

import { demoProfile, validateClaims, HEAD_TEXT_PATTERN, type DemoClaim, type DemoProfileSpec } from './demo-claims';

export interface DemoInput {
    profile: DemoProfileSpec;
    /** Head values by field name, text and select as strings, numbers as numbers. */
    head: Record<string, string | number>;
    /** The claims to prove, primary included. All ride in ONE transaction. */
    claims: DemoClaim[];
    /**
     * Optional second act (battery only): age the battery (telemetry) and
     * repurpose it, which re-anchors the passport as a second on-chain version.
     */
    secondLife: boolean;
}

export interface DemoValidation {
    ok: boolean;
    errors: string[];
    value?: DemoInput;
}

export function validateDemoInput(raw: Record<string, unknown>): DemoValidation {
    const errors: string[] = [];

    let profile: DemoProfileSpec;
    try { profile = demoProfile(raw.profile); } catch (e) { return { ok: false, errors: [(e as Error).message] }; }

    const headRaw = (raw.head && typeof raw.head === 'object' ? raw.head : {}) as Record<string, unknown>;
    const head: Record<string, string | number> = {};
    for (const f of profile.head) {
        const v = headRaw[f.name];
        if (f.kind === 'number') {
            const n = Number(v);
            if (!(Number.isFinite(n) && n >= (f.min ?? -Infinity) && n <= (f.max ?? Infinity))) {
                errors.push(`${f.name}: ${f.min} to ${f.max}`);
                continue;
            }
            head[f.name] = n;
        } else if (f.kind === 'select') {
            const s = String(v ?? '').trim();
            const option = (f.options ?? []).find((o) => o.toLowerCase() === s.toLowerCase());
            if (option === undefined) { errors.push(`${f.name}: one of ${(f.options ?? []).join(', ')}`); continue; }
            head[f.name] = option;
        } else {
            const s = String(v ?? '').trim();
            const re = new RegExp(`^(?:${f.pattern ?? HEAD_TEXT_PATTERN})$`);
            if (!re.test(s)) { errors.push(`${f.name}: 2-40 chars, letters/digits/space/._- only`); continue; }
            head[f.name] = s;
        }
    }

    const claimCheck = validateClaims(profile, raw.claims);
    errors.push(...claimCheck.errors);

    const secondLife = raw.secondLife === true || raw.secondLife === 'true';
    if (secondLife && !profile.secondLife) errors.push(`secondLife is not offered for ${profile.label.toLowerCase()}s`);

    if (errors.length) return { ok: false, errors };
    return { ok: true, errors, value: { profile, head, claims: claimCheck.claims, secondLife } };
}

export function validNickname(raw: unknown): string | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    return /^[A-Za-z0-9 ._\-]{2,24}$/.test(s) ? s : null;
}
