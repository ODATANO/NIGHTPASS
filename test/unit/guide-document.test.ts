import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuideDocument, guideDppId } from '../../srv/lib/guide-document';
import { defaultGuideAttributes, hashableAttributes } from '../../srv/lib/guide-attribute-defaults';

/**
 * The guide-document builder renders a real passport (typed fields plus
 * PassportAttributes rows) as the BatteryPass-Ready guide format. It must
 * stay in sync with scripts/bp-ready-payload.mjs; the invariants tested here
 * are the ones the official validator checked green on 2026-07-17.
 */

const PASSPORT = {
    passportId: 'BAT-TEST-1',
    model: 'PowerCell EV-75',
    manufacturerId: 'DE-CELLCO-001',
    batteryCategory: 'EV',
    manufactureDate: '2026-07-01',
    weightKg: 432.5,
    performanceClass: 'B',
    modifiedAt: '2026-07-15T05:29:04.222Z',
    status: 'anchored',
};
const BATTERY = {
    serialNumber: 'SN-1',
    cellChemistry: 'NMC-811',
    capacityKwh: 75,
    carbonFootprintKgCO2: 3412.75,
    cycleLife: null,
    roundTripEfficiencyPct: null,
};
const RECYCLED = [{ material: 'Co', recycledPercentage: 16.5 }];
const ATTRS = [
    { section: 'PerformanceAndDurability', attribute: 'RatedCapacity', valueJson: '{"amperehourMiliamperehourValue":200,"ampereHourMiliamperehour":"Ah"}' },
    { section: 'SupplyChainDueDiligence', attribute: 'SupplyChainIndices', valueJson: '"Cobalt origin: Australia (60%)"' },
    // A KV row must never override a typed field.
    { section: 'IdentifiersAndProductData', attribute: 'BatteryModelIdentifier', valueJson: '"WRONG"' },
];

describe('buildGuideDocument', () => {
    const doc = buildGuideDocument(PASSPORT, [BATTERY], RECYCLED, ATTRS) as any;
    const bp = doc.Battery_Passport;

    it('renders identifiers with urn ids and typed-field precedence', () => {
        assert.equal(bp.IdentifiersAndProductData.UniqueBatteryPassportIdentifierUniqueDPPIdentifier, guideDppId('BAT-TEST-1'));
        assert.equal(bp.IdentifiersAndProductData.BatteryModelIdentifier, 'PowerCell EV-75');
        assert.equal(bp.IdentifiersAndProductData.BatteryCategory.batteryCategoryValue, 'electric vehicle battery');
        assert.equal(bp.IdentifiersAndProductData.BatteryMass.gramKgValue, 432.5);
        assert.equal(bp.IdentifiersAndProductData['Date-timeOfLatestUpdateOfDPP'], '2026-07-15T05:29:04Z');
    });
    it('maps chemistry to the closed enum and CF to integer/per-kWh', () => {
        assert.equal(bp.BatteryMaterialsAndComposition.BatteryChemistry.chemicalCodeValue, 'Li-ion NMC');
        assert.equal(bp.BatteryMaterialsAndComposition.BatteryChemistry.additionallyPossibleValue, 'NMC-811');
        assert.equal(bp.BatteryCarbonFootprint.AbsoluteBatteryCarbonFootprint['kgCO2-equivalentValue'], 3413);
        assert.equal(bp.BatteryCarbonFootprint.BatteryCarbonFootprintPerFunctionalUnit['kgCO2-equivalentPerKilowattHourValue'], 45.5);
    });
    it('merges KV attribute rows into their sections', () => {
        assert.equal(bp.PerformanceAndDurability.RatedCapacity.amperehourMiliamperehourValue, 200);
        assert.equal(bp.SupplyChainDueDiligence.SupplyChainIndices, 'Cobalt origin: Australia (60%)');
        assert.equal(bp.CircularityAndResourceEfficiency['Post-consumerRecycledCobaltShare'].percentageValue, 16.5);
    });
    it('omits empty sections instead of serving empty objects', () => {
        const bare = buildGuideDocument(PASSPORT, [], [], []) as any;
        assert.equal(bare.Battery_Passport.SupplyChainDueDiligence, undefined);
        assert.ok(bare.Battery_Passport.IdentifiersAndProductData);
    });
});

describe('defaultGuideAttributes', () => {
    const rows = defaultGuideAttributes({ passportId: 'BAT-X', model: 'M1', performanceClass: 'B' });
    it('emits the full longlist default set with correct class split', () => {
        assert.equal(rows.length, 65);
        const byClass = rows.reduce((m: Record<string, number>, r) => ((m[r.accessClass] = (m[r.accessClass] ?? 0) + 1), m), {});
        assert.deepEqual(byClass, { public: 48, legitimateInterest: 16, authority: 1 });
        assert.ok(rows.every((r) => typeof JSON.parse(r.valueJson) !== 'undefined'));
    });
    it('hashableAttributes is order-stable (same hash input regardless of row order)', () => {
        const shuffled = [...rows].reverse();
        assert.deepEqual(hashableAttributes(shuffled), hashableAttributes(rows));
    });
});
