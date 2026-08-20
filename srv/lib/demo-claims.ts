/**
 * The confidential battery values a demo visitor can prove, and the rules for
 * a valid claim (pure, unit-tested).
 *
 * Two claim kinds:
 *   - numeric: one battery column the demo writes into the passport and then
 *     proves a predicate over ("at most 4000", "at least 2000"). Direction is
 *     per field and not a visitor choice: for a footprint, lower is the good
 *     claim; for capacity, cycle life and efficiency, higher is.
 *   - membership: a string column (cell chemistry) whose hidden value is
 *     proven to be ONE of a published allow-list, without revealing which.
 *     The visitor picks the value from the list itself, so the claim is true
 *     by construction (a false claim would abort the whole batch at local
 *     proving).
 *
 * The value itself stays confidential either way: it lives in the encrypted
 * payload and in the Merkle content root, never in the public explorer row.
 * Only the claim (predicate + threshold, or membership + allow-list) becomes
 * public, bound to that field of that passport.
 */

import { claimSetById, type ClaimSet } from './claim-sets';

export interface ClaimField {
    kind?: 'numeric';
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

export interface MembershipClaimField {
    kind: 'membership';
    /** Battery column, must be in passport-anchor's STRING_PROVABLE_FIELDS. */
    field: string;
    label: string;
    /** Named allow-list from claim-sets.ts; the picker options ARE the set. */
    setId: string;
    /** The visitor's default pick (must be a member). */
    defaultValue: string;
}

export type DemoClaimField = ClaimField | MembershipClaimField;

export const CLAIM_FIELDS: readonly DemoClaimField[] = [
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
    {
        kind: 'membership', field: 'cellChemistry', label: 'Cell chemistry',
        setId: 'chemistry-known', defaultValue: 'Li-ion NMC',
    },
] as const;

/** The one claim every run proves; visitors add the rest. */
export const PRIMARY_CLAIM_FIELD = 'carbonFootprintKgCO2';

/** How many claims one run may prove. They ride in ONE transaction. */
export const MAX_DEMO_CLAIMS = CLAIM_FIELDS.length;

export type DemoClaim =
    | {
        field: string;
        /** Confidential numeric value written into the passport. */
        value: number;
        /** Public threshold the predicate is proven against. */
        threshold: number;
    }
    | {
        field: string;
        /** Confidential string value (a member of the field's allow-list). */
        member: string;
    };

export function claimFieldByName(field: string): DemoClaimField | undefined {
    return CLAIM_FIELDS.find((c) => c.field === field);
}

/** The allow-list behind a membership claim field. */
export function membershipSetFor(spec: MembershipClaimField): ClaimSet | undefined {
    return claimSetById(spec.setId);
}

/** Whether a numeric claim actually holds. A false one aborts during local proving. */
export function claimHolds(spec: ClaimField, value: number, threshold: number): boolean {
    return spec.predicate === 'lessOrEqual' ? value <= threshold : value >= threshold;
}

/** A claim resolved to everything the prove action needs. */
export type ResolvedClaim =
    | {
        field: string; value: number; threshold: number;
        predicate: 'lessOrEqual' | 'greaterOrEqual';
        unit: string; label: string;
    }
    | {
        field: string; member: string;
        predicate: 'setMembership';
        setId: string; setLabel: string; label: string;
    };

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
    const out: ResolvedClaim[] = [];
    for (const spec of CLAIM_FIELDS) {
        const c = byField.get(spec.field);
        if (!c) continue;
        if (spec.kind === 'membership') {
            if (!('member' in c)) continue;
            const set = membershipSetFor(spec);
            out.push({
                field: spec.field, member: c.member, predicate: 'setMembership',
                setId: spec.setId, setLabel: set?.label ?? spec.setId, label: spec.label,
            });
        } else if ('value' in c) {
            out.push({
                field: spec.field, value: c.value, threshold: c.threshold,
                predicate: spec.predicate, unit: spec.unit, label: spec.label,
            });
        }
    }
    return out;
}

/**
 * The battery row the demo writes: every claimed field carries the visitor's
 * confidential value, unclaimed ones keep their demo default so the passport
 * stays a plausible battery either way. The chemistry is ALWAYS emitted (the
 * membership leaf must be populated for the field to be provable).
 */
export function demoBatteryValues(input: {
    co2Kg: number; extraClaims?: DemoClaim[];
}): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    for (const spec of CLAIM_FIELDS) out[spec.field] = spec.defaultValue;
    out[PRIMARY_CLAIM_FIELD] = input.co2Kg;
    for (const c of input.extraClaims ?? []) {
        if (!claimFieldByName(c.field)) continue;
        out[c.field] = 'member' in c ? c.member : c.value;
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
 * and thresholds in range (numeric) or a member of the allow-list
 * (membership), and every claim TRUE.
 *
 * The truth requirement is not pedantry. A false claim fails during LOCAL
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

        if (spec.kind === 'membership') {
            const member = String(e.member ?? '').trim();
            const set = membershipSetFor(spec);
            if (!member || !set || !set.values.includes(member)) {
                errors.push(`${field}: '${member}' is not in the ${set?.label ?? spec.setId} list`);
                continue;
            }
            claims.push({ field, member });
            continue;
        }

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
