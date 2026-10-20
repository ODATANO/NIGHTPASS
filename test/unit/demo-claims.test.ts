import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEMO_PROFILES, demoProfile, maxDemoClaims, claimHolds, claimFieldByName,
    membershipSetFor, validateClaims, demoClaimList, demoChildRows, type DemoClaim,
} from '../../srv/lib/demo-claims';
import { APP_PROFILES, PROFILE_IDS } from '../../srv/lib/product-profiles';
import { collectFieldValues, fieldKindOf, panelOf } from '@odatano/dpp-sdk/profile';
import { claimSetById } from '../../srv/lib/claim-sets';

const BATTERY = DEMO_PROFILES.battery;
const COMPONENT = DEMO_PROFILES.component;

/** Every claim built from a spec's defaults (true by construction). */
function defaultClaims(profile = BATTERY): DemoClaim[] {
    return profile.claims.map((c) => c.kind === 'membership'
        ? { field: c.field, member: c.defaultValue }
        : { field: c.field, value: c.defaultValue, threshold: c.defaultThreshold });
}

describe('claim catalogue', () => {
    // A field the circuit cannot prove would fail deep in the run, after the
    // visitor already waited for the anchor.
    it('only lists fields of the family panel, with the right kind', () => {
        for (const id of PROFILE_IDS) {
            const profile = APP_PROFILES[id].profile;
            for (const c of DEMO_PROFILES[id].claims) {
                assert.equal(fieldKindOf(profile, c.field), c.kind === 'membership' ? 'string' : 'numeric', `${id}.${c.field}`);
                if (c.kind === 'membership') assert.ok(claimSetById(c.setId), `${c.field} references unknown set '${c.setId}'`);
            }
            assert.ok(DEMO_PROFILES[id].claims.length <= 8, 'a proof cart holds at most 8 claims');
        }
    });

    it('starts every family with a true default claim and a numeric primary', () => {
        for (const id of PROFILE_IDS) {
            const spec = DEMO_PROFILES[id];
            for (const c of spec.claims) {
                if (c.kind === 'membership') assert.ok(membershipSetFor(c)?.values.includes(c.defaultValue), `${c.field} default is not a member`);
                else assert.ok(claimHolds(c, c.defaultValue, c.defaultThreshold), `${c.field} default claim is false`);
            }
            const primary = claimFieldByName(spec, spec.primary);
            assert.ok(primary && primary.kind !== 'membership', `${id}: primary must be numeric`);
        }
    });

    it('resolves a family by id and defaults to the battery', () => {
        assert.equal(demoProfile(undefined).id, 'battery');
        assert.equal(demoProfile('component').id, 'component');
        assert.throws(() => demoProfile('tyre'), /unknown product profile/);
        assert.equal(maxDemoClaims(COMPONENT), COMPONENT.claims.length);
    });
});

describe('validateClaims', () => {
    const primary = { field: 'carbonFootprintKgCO2', value: 3000, threshold: 4000 };

    it('accepts in-range true claims and requires the primary one', () => {
        const ok = { field: 'cycleLife', value: 2000, threshold: 1500 };
        assert.deepEqual(validateClaims(BATTERY, [primary, ok]).claims, [primary, ok]);
        assert.equal(validateClaims(BATTERY, [ok]).ok, false);
        assert.equal(validateClaims(BATTERY, undefined).ok, false);
    });

    it('rejects unknown fields, duplicates, non-arrays and foreign-family fields', () => {
        assert.equal(validateClaims(BATTERY, [primary, { field: 'secretSauce', value: 1, threshold: 1 }]).ok, false);
        assert.equal(validateClaims(BATTERY, [primary, primary]).ok, false);
        assert.equal(validateClaims(BATTERY, { field: 'cycleLife' }).ok, false);
        assert.equal(validateClaims(COMPONENT, [{ field: 'carbonFootprintKgCO2', value: 1, threshold: 2 }]).ok, false);
    });

    it('rejects values and thresholds outside the catalogue bounds', () => {
        assert.equal(validateClaims(BATTERY, [primary, { field: 'recycledContentPct', value: 140, threshold: 10 }]).ok, false);
        assert.equal(validateClaims(BATTERY, [primary, { field: 'cycleLife', value: 'x', threshold: 1 }]).ok, false);
    });

    it('rejects a FALSE claim with the direction spelled out', () => {
        const tooHigh = validateClaims(BATTERY, [{ field: 'carbonFootprintKgCO2', value: 5000, threshold: 4000 }]);
        assert.equal(tooHigh.ok, false);
        assert.match(tooHigh.errors[0], /not at most/);
        const tooLow = validateClaims(COMPONENT, [{ field: 'cobaltContentPpm', value: 100, threshold: 200 }, { field: 'yieldStrengthMpa', value: 400, threshold: 450 }]);
        assert.match(tooLow.errors[0], /not at least/);
    });

    it('membership claims must name a member of the published list, exactly spelled', () => {
        const good = validateClaims(COMPONENT, [{ field: 'cobaltContentPpm', value: 120, threshold: 200 }, { field: 'materialGrade', member: 'SA-182 F316L' }]);
        assert.equal(good.ok, true);
        assert.equal(validateClaims(COMPONENT, [{ field: 'materialGrade', member: 'sa-182 f316l' }]).ok, false);
        assert.equal(validateClaims(COMPONENT, [{ field: 'supplierId', member: 'QSL-9999' }]).ok, false);
        assert.equal(validateClaims(COMPONENT, [{ field: 'testMethod' }]).ok, false);
    });

    it('caps the cart at the catalogue size', () => {
        const many = defaultClaims(COMPONENT);
        assert.equal(validateClaims(COMPONENT, many).ok, true);
        assert.equal(validateClaims(COMPONENT, [...many, ...many]).ok, false);
    });
});

describe('demoClaimList', () => {
    it('orders the cart like the catalogue and resolves predicates, units and sets', () => {
        const list = demoClaimList(COMPONENT, [
            { field: 'materialGrade', member: 'SA-516 Gr.70' },
            { field: 'cobaltContentPpm', value: 90, threshold: 200 },
            { field: 'yieldStrengthMpa', value: 500, threshold: 450 },
        ]);
        assert.deepEqual(list.map((c) => c.field), ['cobaltContentPpm', 'yieldStrengthMpa', 'materialGrade']);
        assert.deepEqual(list[0], { field: 'cobaltContentPpm', value: 90, threshold: 200, predicate: 'lessOrEqual', unit: 'ppm', label: 'Cobalt content' });
        const grade = list[2];
        assert.equal(grade.predicate, 'setMembership');
        if (grade.predicate === 'setMembership') {
            assert.equal(grade.setId, 'grade-approved');
            assert.equal(grade.setLabel, 'Approved material grades');
        }
    });

    it('drops claims the family does not know', () => {
        const list = demoClaimList(BATTERY, [{ field: 'cobaltContentPpm', value: 1, threshold: 2 }]);
        assert.deepEqual(list, []);
    });
});

describe('demoChildRows', () => {
    const ctx = { nonce: 'abcd1234', today: '2026-10-19' };

    it('places every claimed value where the profile sources the field, the rest defaults', () => {
        const rows = demoChildRows(COMPONENT, [
            { field: 'cobaltContentPpm', value: 90, threshold: 200 },
            { field: 'testMethod', member: 'RT' },
        ], ctx);
        const cert = rows.materialCertificates[0];
        assert.equal(cert.cobaltContentPpm, 90);
        assert.equal(cert.yieldStrengthMpa, 485);
        assert.equal(cert.materialGrade, 'SA-508 Gr.3 Cl.1');
        assert.equal(cert.heatNumber, 'H-abcd1234');
        assert.equal(rows.qualificationTests[0].testMethod, 'RT');
        assert.equal(rows.custodyRecords[0].transferredOn, '2026-10-19');
    });

    it('fills every panel field the catalogue covers, so each membership leaf is provable', () => {
        for (const id of PROFILE_IDS) {
            const rows = demoChildRows(DEMO_PROFILES[id], defaultClaims(DEMO_PROFILES[id]), ctx);
            const values = collectFieldValues(APP_PROFILES[id].profile, rows);
            for (const c of DEMO_PROFILES[id].claims) assert.ok(c.field in values, `${id}.${c.field} missing from the tree values`);
            for (const k of Object.keys(values)) assert.ok(panelOf(APP_PROFILES[id].profile).includes(k));
        }
    });

    it('keeps the battery row shape: serial plus the catalogue values', () => {
        const rows = demoChildRows(BATTERY, [{ field: 'carbonFootprintKgCO2', value: 2500, threshold: 4000 }], ctx);
        assert.equal(rows.batteries[0].serialNumber, 'TRY-abcd1234');
        assert.equal(rows.batteries[0].carbonFootprintKgCO2, 2500);
        assert.equal(rows.batteries[0].cellChemistry, 'Li-ion NMC');
    });
});
