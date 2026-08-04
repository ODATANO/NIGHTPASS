/**
 * The confidential battery values a demo visitor can prove, and the rules for
 * a valid claim (pure, unit-tested).
 *
 * Each entry is one battery column the demo writes into the passport and can
 * then prove a predicate over. The value itself stays confidential: it lives
 * in the encrypted payload and in the Merkle content root, never in the public
 * explorer row. Only the predicate ("at most 4000", "at least 2000") becomes
 * public, bound to that field of that passport.
 *
 * Direction is per field and not a visitor choice: for a footprint, lower is
 * the good claim; for capacity, cycle life and efficiency, higher is.
 */

export interface ClaimField {
    /** Battery column, must be in passport-anchor's BATTERY_PROVABLE_FIELDS. */
    field: string;
    label: string;
    unit: string;
    predicate: 'lessOrEqual' | 'greaterOrEqual';
    /** Inclusive bounds for the confidential value the visitor enters. */
    min: number;
    max: number;
    /** Defaults the form starts with (a true claim out of the box). */
    defaultValue: number;
    defaultThreshold: number;
}

export const CLAIM_FIELDS: readonly ClaimField[] = [
    {
        field: 'carbonFootprintKgCO2', label: 'Carbon footprint', unit: 'kg CO2e',
        predicate: 'lessOrEqual', min: 1, max: 100000, defaultValue: 3500, defaultThreshold: 4000,
    },
    {
        field: 'capacityKwh', label: 'Usable capacity', unit: 'kWh',
        predicate: 'greaterOrEqual', min: 1, max: 1000, defaultValue: 60, defaultThreshold: 50,
    },
    {
        field: 'cycleLife', label: 'Cycle life', unit: 'cycles',
        predicate: 'greaterOrEqual', min: 1, max: 20000, defaultValue: 1800, defaultThreshold: 1500,
    },
    {
        field: 'recycledContentPct', label: 'Recycled content', unit: '%',
        predicate: 'greaterOrEqual', min: 0, max: 100, defaultValue: 16, defaultThreshold: 10,
    },
] as const;

/** The one claim every run proves; visitors add the rest. */
export const PRIMARY_CLAIM_FIELD = 'carbonFootprintKgCO2';

/** How many claims one run may prove. They ride in ONE transaction. */
export const MAX_DEMO_CLAIMS = CLAIM_FIELDS.length;

export interface DemoClaim {
    field: string;
    /** Confidential value written into the passport. */
    value: number;
    /** Public threshold the predicate is proven against. */
    threshold: number;
}

export function claimFieldByName(field: string): ClaimField | undefined {
    return CLAIM_FIELDS.find((c) => c.field === field);
}

/** Whether a claim actually holds. A false one aborts during local proving. */
export function claimHolds(spec: ClaimField, value: number, threshold: number): boolean {
    return spec.predicate === 'lessOrEqual' ? value <= threshold : value >= threshold;
}

/** A claim resolved to everything the prove action needs. */
export interface ResolvedClaim extends DemoClaim {
    predicate: 'lessOrEqual' | 'greaterOrEqual';
    unit: string;
    label: string;
}

/**
 * The full claim list of one run: the carbon footprint (always proven, built
 * from the dedicated co2Kg/proveThreshold inputs) followed by whatever extra
 * claims the visitor picked, in the canonical field order.
 */
export function demoClaimList(input: {
    co2Kg: number; proveThreshold: number; extraClaims?: DemoClaim[];
}): ResolvedClaim[] {
    const byField = new Map<string, DemoClaim>();
    byField.set(PRIMARY_CLAIM_FIELD, {
        field: PRIMARY_CLAIM_FIELD, value: input.co2Kg, threshold: input.proveThreshold,
    });
    for (const c of input.extraClaims ?? []) {
        if (c.field !== PRIMARY_CLAIM_FIELD) byField.set(c.field, c);
    }
    return CLAIM_FIELDS.filter((spec) => byField.has(spec.field)).map((spec) => {
        const c = byField.get(spec.field)!;
        return {
            ...c, predicate: spec.predicate, unit: spec.unit, label: spec.label,
        };
    });
}

/**
 * The battery row the demo writes: every claimed field carries the visitor's
 * confidential value, unclaimed ones keep their demo default so the passport
 * stays a plausible battery either way.
 */
export function demoBatteryValues(input: {
    co2Kg: number; extraClaims?: DemoClaim[];
}): Record<string, number> {
    const out: Record<string, number> = {};
    for (const spec of CLAIM_FIELDS) out[spec.field] = spec.defaultValue;
    out[PRIMARY_CLAIM_FIELD] = input.co2Kg;
    for (const c of input.extraClaims ?? []) {
        if (claimFieldByName(c.field)) out[c.field] = c.value;
    }
    return out;
}

export interface ClaimValidation {
    ok: boolean;
    errors: string[];
    claims: DemoClaim[];
}

/**
 * Validate the visitor's claim list: known fields only, no duplicates, values
 * and thresholds in range, and every claim TRUE.
 *
 * The truth requirement is not pedantry. A false predicate fails during LOCAL
 * proving, before anything is submitted, so the whole batch aborts and the
 * visitor sees a failure with nothing on chain. Rejecting it up front explains
 * the problem instead.
 */
export function validateClaims(raw: unknown): ClaimValidation {
    const errors: string[] = [];
    const claims: DemoClaim[] = [];
    if (raw == null) return { ok: true, errors, claims };
    if (!Array.isArray(raw)) return { ok: false, errors: ['claims must be an array'], claims };
    if (raw.length > MAX_DEMO_CLAIMS) {
        return { ok: false, errors: [`at most ${MAX_DEMO_CLAIMS} claims per run`], claims };
    }

    const seen = new Set<string>();
    for (const entry of raw) {
        const e = (entry ?? {}) as Record<string, unknown>;
        const field = String(e.field ?? '').trim();
        const spec = claimFieldByName(field);
        if (!spec) { errors.push(`unknown claim field '${field}'`); continue; }
        if (seen.has(field)) { errors.push(`duplicate claim for '${field}'`); continue; }
        seen.add(field);

        const value = Number(e.value);
        const threshold = Number(e.threshold);
        if (!(Number.isFinite(value) && value >= spec.min && value <= spec.max)) {
            errors.push(`${field}: value must be ${spec.min} to ${spec.max}`);
            continue;
        }
        if (!(Number.isFinite(threshold) && threshold >= spec.min && threshold <= spec.max * 2)) {
            errors.push(`${field}: threshold must be ${spec.min} to ${spec.max * 2}`);
            continue;
        }
        if (!claimHolds(spec, value, threshold)) {
            const rel = spec.predicate === 'lessOrEqual' ? 'at most' : 'at least';
            errors.push(`${field}: the claim must be true (${value} is not ${rel} ${threshold})`);
            continue;
        }
        claims.push({ field, value, threshold });
    }

    if (errors.length) return { ok: false, errors, claims: [] };
    return { ok: true, errors, claims };
}
