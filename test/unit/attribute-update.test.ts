import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DYNAMIC_ATTRIBUTES,
    encodeDynamicValue,
    dedupeUpdates,
    attributesAsOf,
    type CurrentRowLike,
    type HistoryRowLike,
} from '../../srv/lib/attribute-update';
import { defaultGuideAttributes } from '../../srv/lib/guide-attribute-defaults';

const ok = (attribute: string, value: unknown): string => {
    const r = encodeDynamicValue(attribute, value);
    assert.equal(r.ok, true, `expected ok for ${attribute}: ${(r as any).error ?? ''}`);
    return (r as any).valueJson;
};

const rejected = (attribute: string, value: unknown): void => {
    const r = encodeDynamicValue(attribute, value);
    assert.equal(r.ok, false, `expected rejection for ${attribute}=${JSON.stringify(value)}`);
};

describe('DYNAMIC_ATTRIBUTES allowlist', () => {
    it('covers exactly the seeded dynamic attributes and nothing static or lifecycle', () => {
        assert.equal('BatteryStatus' in DYNAMIC_ATTRIBUTES, false);
        assert.equal('DateOfPuttingTheBatteryIntoService' in DYNAMIC_ATTRIBUTES, false);
        assert.equal('RatedCapacity' in DYNAMIC_ATTRIBUTES, false);
        // Every allowlisted attribute exists in the seeded LMT set (the widest
        // dynamic set) except the EV-only SOCE, which exists in the EV set.
        const lmt = new Set(defaultGuideAttributes({ passportId: 'P', batteryCategory: 'LMT' }).map((r) => r.attribute));
        const ev = new Set(defaultGuideAttributes({ passportId: 'P', batteryCategory: 'EV' }).map((r) => r.attribute));
        for (const name of Object.keys(DYNAMIC_ATTRIBUTES)) {
            assert.equal(lmt.has(name) || ev.has(name), true, `${name} not in any seeded set`);
        }
    });
});

describe('encodeDynamicValue', () => {
    it('emits shapes byte-identical to the seeded guide defaults', () => {
        const seeded = new Map(
            defaultGuideAttributes({ passportId: 'P', batteryCategory: 'LMT' }).map((r) => [r.attribute, r.valueJson]),
        );
        // Same raw values as the seeds; encoded output must match the seed bytes,
        // including both ampere-hour unit-key casings.
        assert.equal(ok('CapacityFade', 0.8), seeded.get('CapacityFade'));
        assert.equal(ok('TemperatureInformation', 23), seeded.get('TemperatureInformation'));
        assert.equal(ok('RemainingCapacity', 198), seeded.get('RemainingCapacity'));
        assert.equal(ok('CapacityThroughput', 3200), seeded.get('CapacityThroughput'));
        assert.equal(ok('EnergyThroughput', 120.5), seeded.get('EnergyThroughput'));
        assert.equal(ok('RemainingPowerCapability', { at80: 148500, at20: 118800 }), seeded.get('RemainingPowerCapability'));
        assert.equal(ok('TimeSpentInExtremeTemperaturesAboveBoundary', 42), seeded.get('TimeSpentInExtremeTemperaturesAboveBoundary'));
        assert.equal(ok('NumberOfDeepDischargeEvents', 2), seeded.get('NumberOfDeepDischargeEvents'));
        assert.equal(ok('ExpectedLifetimeInCalendarYears', 12), seeded.get('ExpectedLifetimeInCalendarYears'));
    });

    it('keeps the two ampere-hour casings distinct', () => {
        assert.equal(ok('RemainingCapacity', 190), '{"amperehourMiliamperehourValue":190,"ampereHourMiliamperehour":"Ah"}');
        assert.equal(ok('CapacityThroughput', 3300), '{"amperehourMiliamperehourValue":3300,"amperehourMiliamperehour":"Ah"}');
    });

    it('rejects out-of-range and mistyped values', () => {
        rejected('CapacityFade', -0.1);
        rejected('CapacityFade', 100.1);
        rejected('CapacityFade', NaN);
        rejected('CapacityFade', '5');
        rejected('NumberOfDeepDischargeEvents', 1.5);
        rejected('NumberOfDeepDischargeEvents', -1);
        rejected('RemainingPowerCapability', { at80: 100 });
        rejected('RemainingPowerCapability', 100);
        rejected('InformationOnAccidents', '');
        rejected('InformationOnAccidents', 'x'.repeat(2001));
        rejected('EnergyThroughput', -5);
        // The official validator requires integers for these three.
        rejected('RemainingCapacity', 190.5);
        rejected('CapacityThroughput', 3300.5);
        rejected('TemperatureInformation', 21.5);
    });

    it('rejects non-allowlisted attributes', () => {
        rejected('BatteryStatus', { batteryStatusValues: 'original' });
        rejected('RatedCapacity', 200);
        rejected('NoSuchAttribute', 1);
    });
});

describe('dedupeUpdates', () => {
    it('keeps the last entry per attribute', () => {
        const out = dedupeUpdates([
            { attribute: 'CapacityFade', value: 1 },
            { attribute: 'PowerFade', value: 2 },
            { attribute: 'CapacityFade', value: 3 },
        ]);
        assert.deepEqual(out, [{ attribute: 'CapacityFade', value: 3 }, { attribute: 'PowerFade', value: 2 }]);
    });
});

describe('attributesAsOf', () => {
    const row = (attribute: string, valueJson: string): CurrentRowLike =>
        ({ section: 'PerformanceAndDurability', attribute, valueJson, accessClass: 'legitimateInterest' });
    const hist = (attribute: string, valueJson: string, version: number, validFrom: string): HistoryRowLike =>
        ({ attribute, valueJson, version, validFrom });

    const current = [row('CapacityFade', '{"v":"now"}'), row('PowerFade', '{"v":"untouched"}')];
    const history = [
        hist('CapacityFade', '{"v":"baseline"}', 0, '2026-01-01T00:00:00Z'),
        hist('CapacityFade', '{"v":"first"}', 1, '2026-03-01T00:00:00Z'),
        hist('CapacityFade', '{"v":"second"}', 2, '2026-06-01T00:00:00Z'),
    ];

    it('returns the baseline before the first update', () => {
        const { rows, lastChangeAt } = attributesAsOf(current, history, '2026-02-01T00:00:00Z');
        assert.equal(rows.find((r) => r.attribute === 'CapacityFade')?.valueJson, '{"v":"baseline"}');
        assert.equal(lastChangeAt, undefined);
    });

    it('returns the correct version between updates and reports lastChangeAt', () => {
        const { rows, lastChangeAt } = attributesAsOf(current, history, '2026-04-01T00:00:00Z');
        assert.equal(rows.find((r) => r.attribute === 'CapacityFade')?.valueJson, '{"v":"first"}');
        assert.equal(lastChangeAt, '2026-03-01T00:00:00.000Z');
    });

    it('returns the latest version at or after the last update', () => {
        const { rows, lastChangeAt } = attributesAsOf(current, history, '2026-06-01T00:00:00Z');
        assert.equal(rows.find((r) => r.attribute === 'CapacityFade')?.valueJson, '{"v":"second"}');
        assert.equal(lastChangeAt, '2026-06-01T00:00:00.000Z');
    });

    it('breaks same-timestamp ties by the higher version', () => {
        const collide = [
            hist('CapacityFade', '{"v":"a"}', 1, '2026-03-01T00:00:00Z'),
            hist('CapacityFade', '{"v":"b"}', 2, '2026-03-01T00:00:00Z'),
        ];
        const { rows } = attributesAsOf(current, collide, '2026-03-01T00:00:00Z');
        assert.equal(rows.find((r) => r.attribute === 'CapacityFade')?.valueJson, '{"v":"b"}');
    });

    it('falls back to the lowest version when nothing qualifies yet', () => {
        const { rows } = attributesAsOf(current, history, '2025-12-01T00:00:00Z');
        assert.equal(rows.find((r) => r.attribute === 'CapacityFade')?.valueJson, '{"v":"baseline"}');
    });

    it('passes attributes without history through unchanged', () => {
        const { rows } = attributesAsOf(current, history, '2026-04-01T00:00:00Z');
        assert.equal(rows.find((r) => r.attribute === 'PowerFade')?.valueJson, '{"v":"untouched"}');
    });

    it('normalizes Date objects from the pg adapter', () => {
        const withDates = [
            hist('CapacityFade', '{"v":"baseline"}', 0, new Date('2026-01-01T00:00:00Z') as unknown as string),
            hist('CapacityFade', '{"v":"first"}', 1, new Date('2026-03-01T00:00:00Z') as unknown as string),
        ];
        const { rows } = attributesAsOf(current, withDates, '2026-03-02T00:00:00Z');
        assert.equal(rows.find((r) => r.attribute === 'CapacityFade')?.valueJson, '{"v":"first"}');
    });
});
