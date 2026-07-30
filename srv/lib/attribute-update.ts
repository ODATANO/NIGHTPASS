/**
 * Dynamic (telemetry / SoH) attribute updates: allowlist, value validation,
 * guide-shape encoding, and as-of history reconstruction. Pure module, no cds
 * import, so the pieces are unit-testable in isolation.
 *
 * Only attributes in DYNAMIC_ATTRIBUTES may be updated after creation, and
 * only when the row already exists on the passport (creation seeds the
 * category-correct set, so category gating is implicit). BatteryStatus and
 * DateOfPuttingTheBatteryIntoService are deliberately excluded: they are
 * lifecycle state, not telemetry (roadmap tasks 1.3 / 1.4).
 *
 * Value shapes MUST stay byte-identical to srv/lib/guide-attribute-defaults.ts
 * so validatePassportConformance stays green after updates. Mind the casing
 * traps: RemainingCapacity uses unit key "ampereHourMiliamperehour" while
 * CapacityThroughput uses all-lowercase "amperehourMiliamperehour", and the
 * TimeSpent times are bare integer minutes without a unit object.
 */

export interface DynamicUpdate { attribute: string; value: unknown }

export interface CurrentRowLike {
    section: string;
    attribute: string;
    valueJson: string;
    accessClass: string;
}

export interface HistoryRowLike {
    attribute: string;
    valueJson: string;
    version: number;
    validFrom: string | Date;
}

type ValueKind =
    | 'pct'            // { percentageValue, percent: '%' }, 0..100
    | 'celsius'        // { celsiusValue, degreeCelsius: '°C' }
    | 'count'          // bare non-negative integer
    | 'ampereHour'     // { amperehourMiliamperehourValue, ampereHourMiliamperehour: 'Ah' }
    | 'ampereHourLc'   // { amperehourMiliamperehourValue, amperehourMiliamperehour: 'Ah' } (lowercase unit key)
    | 'kilowattHour'   // { kilowattHourValue, kilowattHour: 'kWh' }
    | 'wattPair'       // { wattValueAt80SoC, wattValueAt20SoC, watt: 'W' }, input { at80, at20 }
    | 'text';          // plain string

const PERF = 'PerformanceAndDurability';

/** Updatable dynamic attributes: guide name to expected section and value kind. */
export const DYNAMIC_ATTRIBUTES: Record<string, { section: string; kind: ValueKind }> = {
    // Base set (all categories, all legitimateInterest)
    CapacityFade: { section: PERF, kind: 'pct' },
    StateOfCertifiedEnergySOCE: { section: PERF, kind: 'pct' },       // EV only; presence-gated
    StateOfChargeSoC: { section: PERF, kind: 'pct' },
    PowerFade: { section: PERF, kind: 'pct' },
    EnergyRoundTripEfficiencyFade: { section: PERF, kind: 'pct' },
    InternalResistanceIncreaseOfPackCellAndModuleRecommended: { section: PERF, kind: 'pct' },
    ExpectedLifetimeInCalendarYears: { section: PERF, kind: 'count' },
    NumberOfFullChargingAndDischargingCycles: { section: PERF, kind: 'count' },
    TemperatureInformation: { section: PERF, kind: 'celsius' },
    InformationOnAccidents: { section: PERF, kind: 'text' },
    // LMT / STATIONARY dynamic block (presence-gated via the seeded rows)
    RemainingCapacity: { section: PERF, kind: 'ampereHour' },
    RemainingPowerCapability: { section: PERF, kind: 'wattPair' },
    RemainingRoundTripEnergyEfficiency: { section: PERF, kind: 'pct' },
    'EvolutionOfSelf-dischargeRates': { section: PERF, kind: 'pct' },
    EnergyThroughput: { section: PERF, kind: 'kilowattHour' },
    CapacityThroughput: { section: PERF, kind: 'ampereHourLc' },
    TimeSpentInExtremeTemperaturesAboveBoundary: { section: PERF, kind: 'count' },
    TimeSpentInExtremeTemperaturesBelowBoundary: { section: PERF, kind: 'count' },
    TimeSpentChargingDuringExtremeTemperaturesAboveBoundary: { section: PERF, kind: 'count' },
    TimeSpentChargingDuringExtremeTemperaturesBelowBoundary: { section: PERF, kind: 'count' },
    NumberOfDeepDischargeEvents: { section: PERF, kind: 'count' },
};

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export type EncodeResult = { ok: true; valueJson: string } | { ok: false; error: string };

/**
 * Validate a raw value and encode it into the exact guide JSON fragment for
 * the attribute. Raw scalars in, guide shapes out; callers never hand-build
 * unit objects (that is where the casing traps live).
 */
export function encodeDynamicValue(attribute: string, value: unknown): EncodeResult {
    const spec = DYNAMIC_ATTRIBUTES[attribute];
    if (!spec) return { ok: false, error: `attribute is not updatable: ${attribute}` };
    switch (spec.kind) {
        case 'pct':
            if (!isFiniteNumber(value) || value < 0 || value > 100) return { ok: false, error: `${attribute}: expected a number 0..100` };
            return { ok: true, valueJson: JSON.stringify({ percentageValue: value, percent: '%' }) };
        case 'celsius':
            // The official validator requires integer celsiusValue.
            if (!isFiniteNumber(value) || !Number.isInteger(value)) return { ok: false, error: `${attribute}: expected an integer (degrees Celsius)` };
            return { ok: true, valueJson: JSON.stringify({ celsiusValue: value, degreeCelsius: '°C' }) };
        case 'count':
            if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) return { ok: false, error: `${attribute}: expected a non-negative integer` };
            return { ok: true, valueJson: JSON.stringify(value) };
        case 'ampereHour':
            // The official validator requires integer ampere-hour values.
            if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) return { ok: false, error: `${attribute}: expected a non-negative integer (Ah)` };
            return { ok: true, valueJson: JSON.stringify({ amperehourMiliamperehourValue: value, ampereHourMiliamperehour: 'Ah' }) };
        case 'ampereHourLc':
            if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) return { ok: false, error: `${attribute}: expected a non-negative integer (Ah)` };
            return { ok: true, valueJson: JSON.stringify({ amperehourMiliamperehourValue: value, amperehourMiliamperehour: 'Ah' }) };
        case 'kilowattHour':
            if (!isFiniteNumber(value) || value < 0) return { ok: false, error: `${attribute}: expected a non-negative number (kWh)` };
            return { ok: true, valueJson: JSON.stringify({ kilowattHourValue: value, kilowattHour: 'kWh' }) };
        case 'wattPair': {
            const o = value as Record<string, unknown> | null;
            const at80 = o && typeof o === 'object' ? o.at80 : undefined;
            const at20 = o && typeof o === 'object' ? o.at20 : undefined;
            if (!isFiniteNumber(at80) || !isFiniteNumber(at20) || at80 < 0 || at20 < 0) {
                return { ok: false, error: `${attribute}: expected { at80, at20 } with non-negative numbers (W)` };
            }
            return { ok: true, valueJson: JSON.stringify({ wattValueAt80SoC: at80, wattValueAt20SoC: at20, watt: 'W' }) };
        }
        case 'text': {
            if (typeof value !== 'string' || !value.trim() || value.length > 2000) return { ok: false, error: `${attribute}: expected a non-empty string (max 2000 chars)` };
            return { ok: true, valueJson: JSON.stringify(value) };
        }
    }
}

/**
 * Last-wins dedupe by attribute name. Telemetry senders batch naively; the
 * final entry per attribute is the one that counts.
 */
export function dedupeUpdates(updates: DynamicUpdate[]): DynamicUpdate[] {
    const byAttribute = new Map<string, DynamicUpdate>();
    for (const u of updates) byAttribute.set(u.attribute, u);
    return [...byAttribute.values()];
}

const toIso = (v: string | Date): string => new Date(v).toISOString();

/**
 * Reconstruct the attribute rows as of a date. Per attribute with history,
 * pick the highest version whose validFrom is at or before the date (version
 * carries ordering when timestamps collide); with no qualifying row fall back
 * to the lowest version (the creation baseline). Attributes without history
 * pass through unchanged. lastChangeAt is the latest applied non-baseline
 * validFrom, which feeds Date-timeOfLatestUpdateOfDPP of the historical
 * document. Comparison happens in plain JS on normalized ISO strings, so the
 * SQLite and Postgres adapters need no dialect-specific date SQL.
 */
export function attributesAsOf(
    current: CurrentRowLike[],
    history: HistoryRowLike[],
    asOfIso: string,
): { rows: CurrentRowLike[]; lastChangeAt?: string } {
    const asOf = toIso(asOfIso);
    const byAttribute = new Map<string, HistoryRowLike[]>();
    for (const h of history) {
        const list = byAttribute.get(h.attribute);
        if (list) list.push(h); else byAttribute.set(h.attribute, [h]);
    }
    let lastChangeAt: string | undefined;
    const rows = current.map((row) => {
        const versions = byAttribute.get(row.attribute);
        if (!versions?.length) return row;
        const qualifying = versions.filter((v) => toIso(v.validFrom) <= asOf);
        const chosen = qualifying.length
            ? qualifying.reduce((a, b) => (b.version > a.version ? b : a))
            : versions.reduce((a, b) => (b.version < a.version ? b : a));
        if (chosen.version > 0) {
            const at = toIso(chosen.validFrom);
            if (!lastChangeAt || at > lastChangeAt) lastChangeAt = at;
        }
        return { ...row, valueJson: chosen.valueJson };
    });
    return { rows, lastChangeAt };
}
