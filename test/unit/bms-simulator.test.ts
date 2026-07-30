import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateTelemetry, SIMULATED_ATTRIBUTES } from '../../srv/lib/bms-simulator';
import { DYNAMIC_ATTRIBUTES, encodeDynamicValue } from '../../srv/lib/attribute-update';
import { defaultGuideAttributes } from '../../srv/lib/guide-attribute-defaults';

const lmtNames = defaultGuideAttributes({ passportId: 'BAT-SIM-01', batteryCategory: 'LMT' }).map((r) => r.attribute);
const evNames = defaultGuideAttributes({ passportId: 'BAT-SIM-01', batteryCategory: 'EV' }).map((r) => r.attribute);

const valueOf = (frame: ReturnType<typeof generateTelemetry>, attribute: string): unknown =>
    frame.find((u) => u.attribute === attribute)?.value;

describe('bms-simulator', () => {
    it('only simulates allowlisted dynamic attributes', () => {
        for (const name of SIMULATED_ATTRIBUTES) {
            assert.equal(name in DYNAMIC_ATTRIBUTES, true, `${name} not in DYNAMIC_ATTRIBUTES`);
        }
    });

    it('is deterministic: same seed and tick give byte-identical frames', () => {
        const a = generateTelemetry('BAT-SIM-01', 3, lmtNames);
        const b = generateTelemetry('BAT-SIM-01', 3, lmtNames);
        assert.deepEqual(a, b);
        const other = generateTelemetry('BAT-SIM-02', 3, lmtNames);
        assert.notDeepEqual(a, other);
    });

    it('emits only attributes present on the passport', () => {
        const evFrame = generateTelemetry('P', 1, evNames);
        assert.equal(evFrame.some((u) => u.attribute === 'RemainingCapacity'), false);
        assert.equal(evFrame.some((u) => u.attribute === 'StateOfCertifiedEnergySOCE'), true);
        const lmtFrame = generateTelemetry('P', 1, lmtNames);
        assert.equal(lmtFrame.some((u) => u.attribute === 'RemainingCapacity'), true);
        assert.equal(lmtFrame.some((u) => u.attribute === 'StateOfCertifiedEnergySOCE'), false);
    });

    it('every emitted value passes the guide-shape encoder', () => {
        for (const tick of [1, 5, 20, 200]) {
            for (const u of generateTelemetry('BAT-SIM-01', tick, lmtNames)) {
                const r = encodeDynamicValue(u.attribute, u.value);
                assert.equal(r.ok, true, `tick ${tick} ${u.attribute}: ${(r as any).error ?? ''}`);
            }
        }
    });

    it('degrades monotonically across ticks', () => {
        const frames = [1, 2, 3, 8, 15].map((t) => generateTelemetry('BAT-SIM-01', t, lmtNames));
        for (let i = 1; i < frames.length; i++) {
            const prev = frames[i - 1], cur = frames[i];
            assert.ok((valueOf(cur, 'CapacityFade') as number) > (valueOf(prev, 'CapacityFade') as number));
            assert.ok((valueOf(cur, 'RemainingCapacity') as number) < (valueOf(prev, 'RemainingCapacity') as number));
            assert.ok((valueOf(cur, 'CapacityThroughput') as number) > (valueOf(prev, 'CapacityThroughput') as number));
            assert.ok(
                (valueOf(cur, 'NumberOfFullChargingAndDischargingCycles') as number)
                > (valueOf(prev, 'NumberOfFullChargingAndDischargingCycles') as number));
            assert.ok(
                (valueOf(cur, 'NumberOfDeepDischargeEvents') as number)
                >= (valueOf(prev, 'NumberOfDeepDischargeEvents') as number));
            const curPower = valueOf(cur, 'RemainingPowerCapability') as { at80: number; at20: number };
            const prevPower = valueOf(prev, 'RemainingPowerCapability') as { at80: number; at20: number };
            assert.ok(curPower.at80 < prevPower.at80);
            assert.ok(curPower.at20 < prevPower.at20);
        }
    });

    it('rejects non-positive ticks', () => {
        assert.throws(() => generateTelemetry('P', 0, lmtNames));
        assert.throws(() => generateTelemetry('P', 1.5, lmtNames));
    });
});
