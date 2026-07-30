import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    BATTERY_STATUS_VALUES, ALLOWED_TRANSITIONS,
    validateTransition, parseBatteryStatus, encodeBatteryStatus, dppStatusFor,
} from '../../srv/lib/battery-lifecycle';
import { defaultGuideAttributes } from '../../srv/lib/guide-attribute-defaults';

describe('battery lifecycle transitions', () => {
    it('allows original into every second-life state and waste', () => {
        for (const to of ['repurposed', 'reused', 'remanufactured', 'waste'] as const) {
            assert.equal(validateTransition('original', to).ok, true, `original -> ${to}`);
        }
    });

    it('allows second-life states only into waste', () => {
        for (const from of ['repurposed', 'reused', 'remanufactured'] as const) {
            assert.equal(validateTransition(from, 'waste').ok, true, `${from} -> waste`);
            assert.equal(validateTransition(from, 'original').ok, false, `${from} -> original`);
            assert.equal(validateTransition(from, 'repurposed').ok, from === 'repurposed' ? false : false);
        }
    });

    it('treats waste as terminal', () => {
        for (const to of BATTERY_STATUS_VALUES) {
            assert.equal(validateTransition('waste', to).ok, false, `waste -> ${to}`);
        }
        assert.match((validateTransition('waste', 'original') as any).error, /terminal/);
    });

    it('rejects no-op and unknown values, defaults unknown FROM to original', () => {
        assert.equal(validateTransition('original', 'original').ok, false);
        assert.equal(validateTransition('original', 'recycled').ok, false);
        assert.equal(validateTransition('original', undefined).ok, false);
        // Unknown/missing current status behaves like 'original'.
        assert.equal(validateTransition(undefined, 'repurposed').ok, true);
        assert.equal(validateTransition('garbage', 'waste').ok, true);
    });

    it('transition matrix only names known statuses', () => {
        for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
            assert.equal((BATTERY_STATUS_VALUES as readonly string[]).includes(from), true);
            for (const t of targets) assert.equal((BATTERY_STATUS_VALUES as readonly string[]).includes(t), true);
        }
    });
});

describe('battery status encoding', () => {
    it('encodes byte-identical to the seeded guide shape', () => {
        const seeded = defaultGuideAttributes({ passportId: 'P', batteryCategory: 'EV' })
            .find((r) => r.attribute === 'BatteryStatus');
        assert.equal(encodeBatteryStatus('original'), seeded?.valueJson);
        assert.equal(encodeBatteryStatus('repurposed'), '{"batteryStatusValues":"repurposed"}');
    });

    it('parses defensively', () => {
        assert.equal(parseBatteryStatus('{"batteryStatusValues":"waste"}'), 'waste');
        assert.equal(parseBatteryStatus('{"batteryStatusValues":"nonsense"}'), 'original');
        assert.equal(parseBatteryStatus('not json'), 'original');
        assert.equal(parseBatteryStatus(null), 'original');
    });
});

describe('dppStatusFor', () => {
    it('maps waste to Archived and everything else to Active', () => {
        assert.equal(dppStatusFor('waste'), 'Archived');
        assert.equal(dppStatusFor('original'), 'Active');
        assert.equal(dppStatusFor('repurposed'), 'Active');
        assert.equal(dppStatusFor(undefined), 'Active');
    });
});
