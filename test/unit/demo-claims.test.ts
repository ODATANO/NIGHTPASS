import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    CLAIM_FIELDS, PRIMARY_CLAIM_FIELD, MAX_DEMO_CLAIMS, claimHolds, claimFieldByName,
    membershipSetFor, validateClaims, demoClaimList, demoBatteryValues,
} from '../../srv/lib/demo-claims';
import { BATTERY_PROVABLE_FIELDS, STRING_PROVABLE_FIELDS } from '../../srv/lib/passport-anchor';
import { claimSetById } from '../../srv/lib/claim-sets';

/** Every claim built from a spec's defaults (true by construction). */
function defaultClaims() {
    return CLAIM_FIELDS.map((c) => c.kind === 'membership'
        ? { field: c.field, member: c.defaultValue }
        : { field: c.field, value: c.defaultValue, threshold: c.defaultThreshold });
}

describe('claim catalogue', () => {
    // A field the circuit cannot prove would fail deep in the run, after the
    // visitor already waited for the anchor.
    it('only lists fields the proof path supports', () => {
        for (const c of CLAIM_FIELDS) {
            if (c.kind === 'membership') {
                assert.ok((STRING_PROVABLE_FIELDS as readonly string[]).includes(c.field), `${c.field} not provable`);
                assert.ok(claimSetById(c.setId), `${c.field} references unknown set '${c.setId}'`);
            } else {
                assert.ok((BATTERY_PROVABLE_FIELDS as readonly string[]).includes(c.field), `${c.field} not provable`);
            }
        }
    });

    it('ships defaults that form a TRUE claim', () => {
        for (const c of CLAIM_FIELDS) {
            if (c.kind === 'membership') {
                assert.ok(membershipSetFor(c)?.values.includes(c.defaultValue),
                    `${c.field} default '${c.defaultValue}' is not in set '${c.setId}'`);
            } else {
                assert.ok(claimHolds(c, c.defaultValue, c.defaultThreshold), `${c.field} default claim is false`);
            }
        }
    });

    it('has the carbon footprint as the primary claim', () => {
        const primary = claimFieldByName(PRIMARY_CLAIM_FIELD);
        assert.ok(primary && primary.kind !== 'membership');
        assert.equal(primary.predicate, 'lessOrEqual');
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

    it('accepts a membership claim from the allow-list and rejects a non-member', () => {
        const good = validateClaims([{ field: 'cellChemistry', member: 'Li-ion LFP' }]);
        assert.equal(good.ok, true);
        assert.deepEqual(good.claims, [{ field: 'cellChemistry', member: 'Li-ion LFP' }]);
        // Exact-string rule: a different spelling is a different (non-)member.
        assert.equal(validateClaims([{ field: 'cellChemistry', member: 'lfp' }]).ok, false);
        assert.equal(validateClaims([{ field: 'cellChemistry', member: 'Unobtainium' }]).ok, false);
        assert.equal(validateClaims([{ field: 'cellChemistry' }]).ok, false);
    });

    it('caps the number of claims', () => {
        const many = defaultClaims();
        assert.equal(validateClaims(many).ok, true);
        assert.equal(validateClaims([...many, ...many]).ok, false);
        assert.equal(MAX_DEMO_CLAIMS, CLAIM_FIELDS.length);
    });
});

describe('demoClaimList', () => {
    it('always proves the footprint, from the dedicated inputs', () => {
        const list = demoClaimList({ co2Kg: 3000, proveThreshold: 4000 });
        assert.equal(list.length, 1);
        const first = list[0] as { field: string; value: number; threshold: number; predicate: string };
        assert.deepEqual(
            { f: first.field, v: first.value, t: first.threshold, p: first.predicate },
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

    it('resolves a membership claim with its set id and label', () => {
        const list = demoClaimList({
            co2Kg: 3000, proveThreshold: 4000,
            extraClaims: [{ field: 'cellChemistry', member: 'Na-ion' }],
        });
        const m = list.find((c) => c.field === 'cellChemistry');
        assert.ok(m && m.predicate === 'setMembership');
        assert.equal(m.member, 'Na-ion');
        assert.equal(m.setId, 'chemistry-known');
        assert.equal(m.setLabel, claimSetById('chemistry-known')!.label);
    });

    it('never lets an extra claim override the footprint inputs', () => {
        const list = demoClaimList({
            co2Kg: 3000, proveThreshold: 4000,
            extraClaims: [{ field: PRIMARY_CLAIM_FIELD, value: 99, threshold: 99 }],
        });
        assert.equal(list.length, 1);
        assert.equal((list[0] as { value: number }).value, 3000);
    });
});

describe('demoBatteryValues', () => {
    it('writes the claimed values and defaults the rest', () => {
        const v = demoBatteryValues({ co2Kg: 2500, extraClaims: [{ field: 'cycleLife', value: 4000, threshold: 3000 }] });
        assert.equal(v.carbonFootprintKgCO2, 2500);
        assert.equal(v.cycleLife, 4000);
        const cap = claimFieldByName('capacityKwh');
        assert.ok(cap && cap.kind !== 'membership');
        assert.equal(v.capacityKwh, cap.defaultValue);
    });

    it('always emits the chemistry so the membership leaf is provable', () => {
        // Unclaimed: the catalogue default.
        assert.equal(demoBatteryValues({ co2Kg: 1 }).cellChemistry, 'Li-ion NMC');
        // Claimed: the visitor's pick.
        const v = demoBatteryValues({ co2Kg: 1, extraClaims: [{ field: 'cellChemistry', member: 'Li-ion LFP' }] });
        assert.equal(v.cellChemistry, 'Li-ion LFP');
    });

    it('ignores unknown fields', () => {
        const v = demoBatteryValues({ co2Kg: 1, extraClaims: [{ field: 'nope', value: 5, threshold: 1 }] });
        assert.equal(v.nope, undefined);
    });
});
