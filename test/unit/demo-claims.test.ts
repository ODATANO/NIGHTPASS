import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    CLAIM_FIELDS, PRIMARY_CLAIM_FIELD, MAX_DEMO_CLAIMS, claimHolds, claimFieldByName,
    validateClaims, demoClaimList, demoBatteryValues,
} from '../../srv/lib/demo-claims';
import { BATTERY_PROVABLE_FIELDS } from '../../srv/lib/passport-anchor';

describe('claim catalogue', () => {
    // A field the circuit cannot prove would fail deep in the run, after the
    // visitor already waited for the anchor.
    it('only lists fields the proof path supports', () => {
        for (const c of CLAIM_FIELDS) {
            assert.ok((BATTERY_PROVABLE_FIELDS as readonly string[]).includes(c.field), `${c.field} not provable`);
        }
    });

    it('ships defaults that form a TRUE claim', () => {
        for (const c of CLAIM_FIELDS) {
            assert.ok(claimHolds(c, c.defaultValue, c.defaultThreshold), `${c.field} default claim is false`);
        }
    });

    it('has the carbon footprint as the primary claim', () => {
        assert.ok(claimFieldByName(PRIMARY_CLAIM_FIELD));
        assert.equal(claimFieldByName(PRIMARY_CLAIM_FIELD)!.predicate, 'lessOrEqual');
    });
});

describe('validateClaims', () => {
    const ok = { field: 'cycleLife', value: 1800, threshold: 1500 };

    it('accepts a valid claim and an absent list', () => {
        assert.deepEqual(validateClaims([ok]).claims, [ok]);
        assert.deepEqual(validateClaims(undefined), { ok: true, errors: [], claims: [] });
    });

    it('rejects unknown fields, duplicates and non-arrays', () => {
        assert.equal(validateClaims([{ field: 'secretSauce', value: 1, threshold: 1 }]).ok, false);
        assert.equal(validateClaims([ok, ok]).ok, false);
        assert.equal(validateClaims({ field: 'cycleLife' }).ok, false);
    });

    it('rejects out-of-range values and thresholds', () => {
        assert.equal(validateClaims([{ field: 'recycledContentPct', value: 140, threshold: 10 }]).ok, false);
        assert.equal(validateClaims([{ field: 'cycleLife', value: 'x', threshold: 1 }]).ok, false);
    });

    // A false predicate aborts during local proving, before submit: the whole
    // batch dies and the visitor sees a failure with nothing on chain.
    it('rejects a claim that is not true, in both directions', () => {
        const tooHigh = validateClaims([{ field: 'carbonFootprintKgCO2', value: 5000, threshold: 4000 }]);
        assert.equal(tooHigh.ok, false);
        assert.match(tooHigh.errors[0], /must be true/);
        const tooLow = validateClaims([{ field: 'cycleLife', value: 900, threshold: 1500 }]);
        assert.equal(tooLow.ok, false);
    });

    it('caps the number of claims', () => {
        const many = CLAIM_FIELDS.map((c) => ({ field: c.field, value: c.defaultValue, threshold: c.defaultThreshold }));
        assert.equal(validateClaims(many).ok, true);
        assert.equal(validateClaims([...many, ...many]).ok, false);
        assert.equal(MAX_DEMO_CLAIMS, CLAIM_FIELDS.length);
    });
});

describe('demoClaimList', () => {
    it('always proves the footprint, from the dedicated inputs', () => {
        const list = demoClaimList({ co2Kg: 3000, proveThreshold: 4000 });
        assert.equal(list.length, 1);
        assert.deepEqual(
            { f: list[0].field, v: list[0].value, t: list[0].threshold, p: list[0].predicate },
            { f: PRIMARY_CLAIM_FIELD, v: 3000, t: 4000, p: 'lessOrEqual' });
    });

    it('appends extra claims in catalogue order and resolves their predicate', () => {
        const list = demoClaimList({
            co2Kg: 3000, proveThreshold: 4000,
            extraClaims: [
                { field: 'recycledContentPct', value: 20, threshold: 10 },
                { field: 'capacityKwh', value: 60, threshold: 50 },
            ],
        });
        assert.deepEqual(list.map((c) => c.field),
            ['carbonFootprintKgCO2', 'capacityKwh', 'recycledContentPct']);
        assert.equal(list.find((c) => c.field === 'capacityKwh')!.predicate, 'greaterOrEqual');
    });

    it('never lets an extra claim override the footprint inputs', () => {
        const list = demoClaimList({
            co2Kg: 3000, proveThreshold: 4000,
            extraClaims: [{ field: PRIMARY_CLAIM_FIELD, value: 99, threshold: 99 }],
        });
        assert.equal(list.length, 1);
        assert.equal(list[0].value, 3000);
    });
});

describe('demoBatteryValues', () => {
    it('writes the claimed values and defaults the rest', () => {
        const v = demoBatteryValues({ co2Kg: 2500, extraClaims: [{ field: 'cycleLife', value: 4000, threshold: 3000 }] });
        assert.equal(v.carbonFootprintKgCO2, 2500);
        assert.equal(v.cycleLife, 4000);
        assert.equal(v.capacityKwh, claimFieldByName('capacityKwh')!.defaultValue);
    });

    it('ignores unknown fields', () => {
        const v = demoBatteryValues({ co2Kg: 1, extraClaims: [{ field: 'nope', value: 5, threshold: 1 }] });
        assert.equal(v.nope, undefined);
    });
});
