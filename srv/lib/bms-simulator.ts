/**
 * BMS telemetry simulator: a deterministic source of dynamic SoH attribute
 * updates, standing in for a real battery management system.
 *
 * This module is PURE (no `@sap/cds`, no DB, no clock, no randomness): the
 * telemetry frame is a deterministic function of (seed, tick), so the same
 * passport and tick always produce byte-identical values and unit tests can
 * pin the curves. `tick` is an abstract aging step (think one report per
 * service interval); degradation curves are monotonic in it, with a small
 * deterministic jitter derived from an FNV-1a hash so different passports
 * do not report identical values.
 *
 * Values are RAW (encoder-ready): the updateDynamicAttributes action encodes
 * them into the exact guide shapes. Only attributes present on the passport
 * are emitted (pass the passport's current attribute names).
 */

import type { DynamicUpdate } from './attribute-update';

/** FNV-1a 32-bit hash of a string, normalized to [0, 1). */
function jitter(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h / 0x100000000;
}

const round = (n: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
};
const clampPct = (n: number): number => Math.min(100, Math.max(0, round(n, 2)));

/**
 * Per-attribute degradation curves. Each takes the tick and the attribute's
 * jitter j in [0, 1) and returns a raw value. Per-tick increments are larger
 * than the jitter span, so fades and counters stay strictly monotonic across
 * ticks even at the jitter extremes.
 */
const CURVES: Record<string, (tick: number, j: number) => unknown> = {
    // Fades and degradation indicators rise with age.
    CapacityFade: (t, j) => clampPct(0.8 + t * 0.35 + j * 0.1),
    PowerFade: (t, j) => clampPct(0.9 + t * 0.3 + j * 0.1),
    EnergyRoundTripEfficiencyFade: (t, j) => clampPct(0.4 + t * 0.15 + j * 0.05),
    InternalResistanceIncreaseOfPackCellAndModuleRecommended: (t, j) => clampPct(2.1 + t * 0.4 + j * 0.1),
    'EvolutionOfSelf-dischargeRates': (t, j) => clampPct(1.1 + t * 0.05 + j * 0.02),
    StateOfCertifiedEnergySOCE: (t, j) => clampPct(99.2 - t * 0.3 - j * 0.1),
    // Remaining-capability figures fall with age. RemainingCapacity is an
    // integer Ah (validator requirement); the 2-per-tick drop keeps it
    // strictly decreasing across ticks even at the jitter extremes.
    RemainingCapacity: (t, j) => Math.max(0, 198 - 2 * t + Math.floor(j * 2)),
    RemainingPowerCapability: (t, j) => ({
        at80: Math.max(0, Math.round(148500 * (1 - 0.003 * t) - j * 100)),
        at20: Math.max(0, Math.round(118800 * (1 - 0.003 * t) - j * 100)),
    }),
    RemainingRoundTripEnergyEfficiency: (t, j) => clampPct(95.1 - t * 0.12 - j * 0.05),
    ExpectedLifetimeInCalendarYears: (t) => Math.max(1, 12 - Math.floor(t / 6)),
    // Throughput and event counters only ever grow.
    EnergyThroughput: (t, j) => round(120.5 + t * 45.3 + j * 2, 1),
    CapacityThroughput: (t, j) => Math.round(3200 + t * 820 + j * 20),
    NumberOfFullChargingAndDischargingCycles: (t, j) => 14 + t * 25 + Math.floor(j * 5),
    NumberOfDeepDischargeEvents: (t) => 2 + Math.floor(t / 3),
    TimeSpentInExtremeTemperaturesAboveBoundary: (t, j) => 42 + t * 6 + Math.floor(j * 4),
    TimeSpentInExtremeTemperaturesBelowBoundary: (t, j) => 15 + t * 3 + Math.floor(j * 2),
    TimeSpentChargingDuringExtremeTemperaturesAboveBoundary: (t, j) => 8 + t * 2 + Math.floor(j * 1.5),
    TimeSpentChargingDuringExtremeTemperaturesBelowBoundary: (t, j) => 3 + t * 1 + Math.floor(j * 1.5),
    // Operating conditions oscillate in plausible bands (per-tick jitter).
    StateOfChargeSoC: (_t, j) => clampPct(30 + j * 60),
    TemperatureInformation: (_t, j) => Math.round(15 + j * 20),
};

/** Attribute names the simulator can produce (subset of the dynamic allowlist). */
export const SIMULATED_ATTRIBUTES: readonly string[] = Object.keys(CURVES);

/**
 * Deterministically generate the telemetry frame for one aging step. Emits
 * only attributes both simulated and present on the passport, so the frame is
 * always accepted by the presence-gated update action regardless of category.
 */
export function generateTelemetry(seed: string, tick: number, presentAttributes: readonly string[]): DynamicUpdate[] {
    if (!Number.isInteger(tick) || tick < 1) throw new Error('tick must be a positive integer');
    const present = new Set(presentAttributes);
    const out: DynamicUpdate[] = [];
    for (const [attribute, curve] of Object.entries(CURVES)) {
        if (!present.has(attribute)) continue;
        out.push({ attribute, value: curve(tick, jitter(`${seed}:${tick}:${attribute}`)) });
    }
    return out;
}
