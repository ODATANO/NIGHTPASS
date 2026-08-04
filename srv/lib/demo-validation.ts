/**
 * Pure input validation for the "Try it" demo (unit-testable, no CAP).
 *
 * The model and manufacturer strings become PUBLIC explorer content, so the
 * charset is deliberately narrow. Numbers are bounded to plausible battery
 * ranges. The claim must be TRUE (co2Kg <= proveThreshold): the demo's point
 * is a succeeding proof, and the ledger would reject a false one anyway,
 * which reads as a confusing failure to a visitor.
 */

export interface DemoInput {
    model: string;
    manufacturer: string;
    weightKg: number;
    /** Public Annex XIII Point 1 field, shown on the explorer. A to E. */
    performanceClass: string;
    co2Kg: number;
    proveThreshold: number;
    /**
     * Optional second act: age the battery (telemetry) and repurpose it,
     * which re-anchors the passport as a second on-chain version. One more
     * sponsored transaction and one or two extra minutes.
     */
    secondLife: boolean;
    /**
     * Extra confidential values to prove alongside the carbon footprint. All
     * of them ride in ONE transaction, so a visitor pays one wait for any
     * number of claims. The footprint claim is always present (built from
     * co2Kg/proveThreshold) and never appears here twice.
     */
    extraClaims: DemoClaim[];
}

export interface DemoValidation {
    ok: boolean;
    errors: string[];
    value?: DemoInput;
}

import { validateClaims, PRIMARY_CLAIM_FIELD, type DemoClaim } from './demo-claims';

const TEXT_RE = /^[A-Za-z0-9 ._\-]{2,40}$/;

function num(raw: unknown): number {
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
}

export function validateDemoInput(raw: Record<string, unknown>): DemoValidation {
    const errors: string[] = [];

    const model = String(raw.model ?? '').trim();
    const manufacturer = String(raw.manufacturer ?? '').trim();
    if (!TEXT_RE.test(model)) errors.push('model: 2-40 chars, letters/digits/space/._- only');
    if (!TEXT_RE.test(manufacturer)) errors.push('manufacturer: 2-40 chars, letters/digits/space/._- only');

    const weightKg = num(raw.weightKg);
    if (!(weightKg >= 1 && weightKg <= 5000)) errors.push('weightKg: 1 to 5000');
    const performanceClass = String(raw.performanceClass ?? '').trim().toUpperCase();
    if (!/^[A-E]$/.test(performanceClass)) errors.push('performanceClass: one of A, B, C, D, E');
    const co2Kg = num(raw.co2Kg);
    if (!(co2Kg >= 1 && co2Kg <= 100000)) errors.push('co2Kg: 1 to 100000');
    const proveThreshold = num(raw.proveThreshold);
    if (!(proveThreshold >= 1 && proveThreshold <= 200000)) errors.push('proveThreshold: 1 to 200000');
    if (Number.isFinite(co2Kg) && Number.isFinite(proveThreshold) && co2Kg > proveThreshold) {
        errors.push('proveThreshold must be >= co2Kg (the demo proves a TRUE claim)');
    }

    const secondLife = raw.secondLife === true || raw.secondLife === 'true';

    // Extra claims are optional; the footprint claim always comes from
    // co2Kg/proveThreshold above, so a duplicate of it here is rejected.
    const claimCheck = validateClaims(raw.claims);
    errors.push(...claimCheck.errors);
    const extraClaims = claimCheck.claims.filter((c) => c.field !== PRIMARY_CLAIM_FIELD);
    if (claimCheck.claims.length !== extraClaims.length) {
        errors.push(`${PRIMARY_CLAIM_FIELD} is proven from co2Kg/proveThreshold, do not repeat it in claims`);
    }

    if (errors.length) return { ok: false, errors };
    return {
        ok: true, errors,
        value: { model, manufacturer, weightKg, performanceClass, co2Kg, proveThreshold, secondLife, extraClaims }
    };
}

export function validNickname(raw: unknown): string | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    return /^[A-Za-z0-9 ._\-]{2,24}$/.test(s) ? s : null;
}
