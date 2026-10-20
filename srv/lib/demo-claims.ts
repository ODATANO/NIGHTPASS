/**
 * The "Try it" catalog per product family: the public head fields a visitor
 * fills, the confidential values they can prove, and the rules for a valid
 * claim (pure, unit-tested).
 *
 * Two claim kinds:
 *   - numeric: a provable column the demo writes into the passport and then
 *     proves a predicate over ("at most 200", "at least 450"). Direction is
 *     per field and not a visitor choice: for a footprint or a contaminant,
 *     lower is the good claim; for capacity or strength, higher is.
 *   - membership: a string column whose hidden value is proven to be ONE of a
 *     published allow-list, without revealing which. The visitor picks the
 *     value from the list itself, so the claim is true by construction (a
 *     false claim would abort the whole batch at local proving).
 *
 * The value itself stays confidential either way: it lives in the encrypted
 * payload and in the Merkle content root, never in the public explorer row.
 */

import type { ClaimSet } from '@odatano/dpp-sdk/claim-sets';
import type { AttributeRow } from '@odatano/dpp-sdk/attributes';
import { claimSetById } from './claim-sets';
import { APP_PROFILES, isProfileId, type ProfileId } from './product-profiles';

export interface ClaimField {
    kind?: 'numeric';
    /** Provable numeric field of the family's panel. */
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
    /** Provable string field of the family's panel. */
    field: string;
    label: string;
    /** Allow-list id from the app catalog; the picker options ARE the set. */
    setId: string;
    /** The visitor's default pick (must be a member). */
    defaultValue: string;
}

export type DemoClaimField = ClaimField | MembershipClaimField;

/** A public head field the visitor fills; columns go to the passport row, attributes to its attribute rows. */
export interface DemoHeadField {
    name: string;
    label: string;
    kind: 'text' | 'number' | 'select';
    target: 'column' | 'attribute';
    hint?: string;
    options?: readonly string[];
    defaultValue: string | number;
    min?: number;
    max?: number;
    /** Text fields: the whole-value pattern (HTML `pattern` syntax) and length cap the server enforces. */
    pattern?: string;
    maxLength?: number;
}

/** Head text becomes public explorer content, so the charset is deliberately narrow. */
export const HEAD_TEXT_PATTERN = '[A-Za-z0-9 ._\\-]{2,40}';
export const HEAD_TEXT_MAX_LENGTH = 40;

export interface DemoProfileSpec {
    id: ProfileId;
    label: string;
    tagline: string;
    regulation: string;
    /** Passport id prefix of demo runs. */
    idPrefix: string;
    head: readonly DemoHeadField[];
    /** Head columns every run sets without asking. */
    fixedHead: Readonly<Record<string, string>>;
    /** The one claim every run proves; visitors add the rest. */
    primary: string;
    claims: readonly DemoClaimField[];
    /** Whether the family offers the second-act re-anchor (battery ageing and repurpose). */
    secondLife: boolean;
    /** Rows of the family's children a run writes, before the claimed values are placed. */
    childDefaults: (ctx: { nonce: string; today: string }) => Record<string, Record<string, unknown>[]>;
    /** Attribute rows of a run beyond the head attributes. */
    fixedAttributes: readonly AttributeRow[];
}

const TEXT = (name: string, label: string, defaultValue: string, hint?: string): DemoHeadField =>
    ({ name, label, kind: 'text', target: 'column', defaultValue, hint, pattern: HEAD_TEXT_PATTERN, maxLength: HEAD_TEXT_MAX_LENGTH });

export const DEMO_PROFILES: Readonly<Record<ProfileId, DemoProfileSpec>> = {
    battery: {
        id: 'battery',
        label: 'Battery passport',
        tagline: 'An EV battery with a confidential carbon footprint and cell chemistry.',
        regulation: APP_PROFILES.battery.regulation,
        idPrefix: 'BAT-TRY',
        head: [
            TEXT('model', 'Model name', 'TryCell EV-1'),
            TEXT('manufacturerId', 'Manufacturer', 'DemoWorks GmbH'),
            { name: 'weightKg', label: 'Weight (kg)', kind: 'number', target: 'column', defaultValue: 300, min: 1, max: 5000 },
            {
                name: 'performanceClass', label: 'Performance class', kind: 'select', target: 'column',
                options: ['A', 'B', 'C', 'D', 'E'], defaultValue: 'B',
                hint: 'Public, shown on the explorer next to model and weight.',
            },
        ],
        fixedHead: { batteryCategory: 'EV' },
        primary: 'carbonFootprintKgCO2',
        claims: [
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
        ],
        secondLife: true,
        childDefaults: ({ nonce }) => ({
            batteries: [{ serialNumber: `TRY-${nonce}` }],
        }),
        fixedAttributes: [],
    },
    component: {
        id: 'component',
        label: 'Component passport',
        tagline: 'A safety-related forged part with a confidential material certificate and supplier.',
        regulation: APP_PROFILES.component.regulation,
        idPrefix: 'CMP-TRY',
        head: [
            TEXT('model', 'Designation', 'Nozzle forging DN 800'),
            TEXT('manufacturerId', 'Manufacturer', 'DemoForge AG'),
            { name: 'weightKg', label: 'Mass (kg)', kind: 'number', target: 'column', defaultValue: 1840, min: 1, max: 100000 },
            {
                name: 'SafetyClass', label: 'Safety class', kind: 'select', target: 'attribute',
                options: ['1', '2', '3'], defaultValue: '2',
                hint: 'Public, shown on the explorer next to designation and mass.',
            },
        ],
        fixedHead: {},
        primary: 'cobaltContentPpm',
        claims: [
            {
                field: 'cobaltContentPpm', label: 'Cobalt content', unit: 'ppm',
                predicate: 'lessOrEqual', min: 1, max: 5000, defaultValue: 120, defaultThreshold: 200,
            },
            {
                field: 'yieldStrengthMpa', label: 'Yield strength', unit: 'MPa',
                predicate: 'greaterOrEqual', min: 100, max: 2000, defaultValue: 485, defaultThreshold: 450,
            },
            {
                field: 'hardnessHb', label: 'Hardness', unit: 'HB',
                predicate: 'lessOrEqual', min: 50, max: 600, defaultValue: 207, defaultThreshold: 235,
            },
            {
                field: 'wallThicknessMm', label: 'Wall thickness', unit: 'mm',
                predicate: 'greaterOrEqual', min: 1, max: 500, defaultValue: 42.5, defaultThreshold: 40,
            },
            {
                kind: 'membership', field: 'materialGrade', label: 'Material grade',
                setId: 'grade-approved', defaultValue: 'SA-508 Gr.3 Cl.1',
            },
            {
                kind: 'membership', field: 'supplierId', label: 'Supplier',
                setId: 'supplier-qualified', defaultValue: 'QSL-0031',
            },
            {
                kind: 'membership', field: 'testMethod', label: 'Qualification test method',
                setId: 'ndt-approved', defaultValue: 'UT',
            },
        ],
        secondLife: false,
        childDefaults: ({ nonce, today }) => ({
            materialCertificates: [{
                heatNumber: `H-${nonce}`, supplierName: 'Demo Forge Works', tensileStrengthMpa: 655,
                certificateSha256: hexNonce(nonce, 'certificate'),
            }],
            qualificationTests: [{ standard: 'ASME V Art. 4', result: 'pass', reportSha256: hexNonce(nonce, 'report'), inspectorId: 'INS-07' }],
            custodyRecords: [{ step: 1, fromParty: 'Demo Forge Works', toParty: 'Plant stores', transferredOn: today, recordSha256: hexNonce(nonce, 'custody') }],
        }),
        fixedAttributes: [
            { section: 'Identification', attribute: 'ComponentStatus', valueJson: JSON.stringify('qualified'), accessClass: 'public' },
        ],
    },
};

/** Deterministic 64-hex stand-in for an evidence file hash of a demo run. */
function hexNonce(nonce: string, kind: string): string {
    const seed = `${kind}:${nonce}`;
    let out = '';
    for (let i = 0; out.length < 64; i++) out += seed.charCodeAt(i % seed.length).toString(16).padStart(2, '0');
    return out.slice(0, 64);
}

export function demoProfile(id: unknown): DemoProfileSpec {
    if (id == null || id === '') return DEMO_PROFILES.battery;
    if (!isProfileId(id)) throw new Error(`unknown product profile '${String(id)}'`);
    return DEMO_PROFILES[id];
}

/** How many claims one run may prove. They ride in ONE transaction. */
export function maxDemoClaims(profile: DemoProfileSpec): number {
    return profile.claims.length;
}

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

export function claimFieldByName(profile: DemoProfileSpec, field: string): DemoClaimField | undefined {
    return profile.claims.find((c) => c.field === field);
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

/** The claim list of one run in the canonical catalog order (primary first). */
export function demoClaimList(profile: DemoProfileSpec, claims: readonly DemoClaim[]): ResolvedClaim[] {
    const byField = new Map(claims.map((c) => [c.field, c]));
    const out: ResolvedClaim[] = [];
    for (const spec of profile.claims) {
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
 * The child rows a run writes: the family's default rows with every catalog
 * field filled (the visitor's confidential value where claimed, the catalog
 * default otherwise, so the passport stays plausible and every membership
 * leaf is populated). Values land where the profile sources the field.
 */
export function demoChildRows(
    profile: DemoProfileSpec, claims: readonly DemoClaim[], ctx: { nonce: string; today: string },
): Record<string, Record<string, unknown>[]> {
    const rows = profile.childDefaults(ctx);
    const values: Record<string, number | string> = {};
    for (const spec of profile.claims) values[spec.field] = spec.defaultValue;
    for (const c of claims) {
        if (!claimFieldByName(profile, c.field)) continue;
        values[c.field] = 'member' in c ? c.member : c.value;
    }
    const fields = APP_PROFILES[profile.id].profile.provableFields;
    for (const [field, value] of Object.entries(values)) {
        const source = fields.find((f) => f.name === field)?.source;
        if (!source) throw new Error(`demo field '${field}' has no child column in profile '${profile.id}'`);
        const list = rows[source.child] ?? (rows[source.child] = []);
        const m = source.match;
        let row = m ? list.find((r) => String(r[m.column] ?? '') === m.value) : list[0];
        if (!row) {
            row = m ? { [m.column]: m.value } : {};
            list.push(row);
        }
        row[source.column] = value;
    }
    return rows;
}

export interface ClaimValidation {
    ok: boolean;
    errors: string[];
    claims: DemoClaim[];
}

/**
 * Validate the visitor's claim list: known fields only, no duplicates, values
 * and thresholds in range (numeric) or a member of the allow-list
 * (membership), every claim TRUE, and the primary claim present.
 *
 * The truth requirement is not pedantry. A false claim fails during LOCAL
 * proving, before anything is submitted, so the whole batch aborts and the
 * visitor sees a failure with nothing on chain. Rejecting it up front explains
 * the problem instead.
 */
export function validateClaims(profile: DemoProfileSpec, raw: unknown): ClaimValidation {
    const errors: string[] = [];
    const claims: DemoClaim[] = [];
    if (!Array.isArray(raw)) return { ok: false, errors: ['claims must be an array'], claims };
    if (raw.length > maxDemoClaims(profile)) {
        return { ok: false, errors: [`at most ${maxDemoClaims(profile)} claims per run`], claims };
    }

    const seen = new Set<string>();
    for (const entry of raw) {
        const e = (entry ?? {}) as Record<string, unknown>;
        const field = String(e.field ?? '').trim();
        const spec = claimFieldByName(profile, field);
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
    if (!seen.has(profile.primary)) errors.push(`${profile.primary}: the primary claim of every run is required`);

    if (errors.length) return { ok: false, errors, claims: [] };
    return { ok: true, errors, claims };
}
