import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    allowedMaskFor, fieldsFromMask, describeMask, slotOf,
    provableValuesFromPayload, slotsEqual, firstUnmaskedDifference,
    REAL_SLOT_COUNT, SLOT_COUNT,
} from '../../srv/lib/version-integrity';
import { PROVABLE_FIELDS, encryptPayload, decryptPayload } from '../../srv/lib/passport-anchor';

// The mask IS the claim: "these slots may differ, every other slot holds the
// same value". A wrong bit does not fail loudly, it silently states something
// else, so the mapping field name -> bit is pinned here.

describe('allowed mask', () => {
    it('maps field names to their registry slot', () => {
        assert.equal(allowedMaskFor([]), 0, 'the empty mask claims nothing changed at all');
        assert.equal(allowedMaskFor(['carbonFootprintKgCO2']), 1 << slotOf('carbonFootprintKgCO2'));
        assert.equal(
            allowedMaskFor(['capacityKwh', 'cycleLife']),
            (1 << slotOf('capacityKwh')) | (1 << slotOf('cycleLife'))
        );
        // Order and duplicates do not change the statement.
        assert.equal(allowedMaskFor(['cycleLife', 'capacityKwh', 'cycleLife']), allowedMaskFor(['capacityKwh', 'cycleLife']));
    });

    it('round-trips through fieldsFromMask in slot order', () => {
        const fields = ['recycledCoPct', 'capacityKwh'];
        assert.deepEqual(
            fieldsFromMask(allowedMaskFor(fields)),
            [...fields].sort((a, b) => slotOf(a) - slotOf(b))
        );
        assert.deepEqual(fieldsFromMask(0), []);
    });

    it('refuses an unknown field instead of quietly narrowing the claim', () => {
        assert.throws(() => allowedMaskFor(['nope']), /'nope' is not a provable field/);
    });

    it('refuses a vacuous mask that frees every provable field', () => {
        assert.throws(() => allowedMaskFor([...PROVABLE_FIELDS]), /claims nothing/);
    });

    it('never frees padding slots', () => {
        const mask = allowedMaskFor(['capacityKwh']);
        for (let i = REAL_SLOT_COUNT; i < SLOT_COUNT; i++) {
            assert.equal(mask & (1 << i), 0, `padding slot ${i} must stay constrained`);
        }
    });

    it('describes what it claims', () => {
        assert.equal(describeMask(0), 'no provable field changed');
        assert.match(describeMask(allowedMaskFor(['capacityKwh'])), /^only capacityKwh may have changed$/);
    });
});

describe('unmasked difference pre-flight', () => {
    // Mirrors the circuit's absence policy. Getting this wrong in the LENIENT
    // direction is the dangerous case: we would submit a proof the circuit
    // then rejects after minutes, with no indication which field broke it.
    const present = (v: string) => ({ present: true, value: v });
    const bytes = (d: string) => ({ present: true, valueDigest: d });
    const absent = { present: false };

    it('treats both-absent as equal, present-vs-absent as a difference', () => {
        assert.equal(slotsEqual(absent, absent), true);
        assert.equal(slotsEqual(present('1'), absent), false);
        assert.equal(slotsEqual(absent, present('1')), false);
    });

    it('compares uint slots by scaled value and bytes slots by digest', () => {
        assert.equal(slotsEqual(present('75000'), present('75000')), true);
        assert.equal(slotsEqual(present('75000'), present('75001')), false);
        assert.equal(slotsEqual(bytes('AB'.repeat(32)), bytes('ab'.repeat(32))), true, 'digests compare case-insensitively');
        assert.equal(slotsEqual(bytes('a'.repeat(64)), bytes('b'.repeat(64))), false);
    });

    it('names the first field that changed outside the mask', () => {
        const a = PROVABLE_FIELDS.map((_, i) => present(String(i)));
        const b = a.map((s) => ({ ...s }));
        b[slotOf('capacityKwh')] = present('999');
        assert.equal(firstUnmaskedDifference(a, b, 0), 'capacityKwh');
        // Freeing that slot makes the same pair pass.
        assert.equal(firstUnmaskedDifference(a, b, allowedMaskFor(['capacityKwh'])), null);
        // ... but another unmasked change still fails.
        b[slotOf('cycleLife')] = present('42');
        assert.equal(firstUnmaskedDifference(a, b, allowedMaskFor(['capacityKwh'])), 'cycleLife');
    });

    it('holds for identical documents under the strictest mask', () => {
        const a = PROVABLE_FIELDS.map((_, i) => present(String(i)));
        assert.equal(firstUnmaskedDifference(a, a.map((s) => ({ ...s })), 0), null);
    });
});

describe('provable values of an archived version', () => {
    const payload = {
        payloadVersion: 2,
        batteries: [{
            serialNumber: 'SN-1', cellChemistry: 'Li-ion NMC', capacityKwh: 75,
            carbonFootprintKgCO2: 3500, supplierName: 'ACME', recycledContentPct: 16,
            cycleLife: 1800, roundTripEfficiencyPct: 92, leadContentPpm: 40,
        }],
        recycledMaterials: [
            { material: 'Co', recycledPercentage: 16 },
            { material: 'Li', recycledPercentage: 6 },
            { material: 'Xx', recycledPercentage: 99 },  // not a registry field
        ],
        diligenceDocs: [],
        attributes: [],
    };

    it('extracts exactly the registry fields, typed by slot kind', () => {
        const values = provableValuesFromPayload(payload);
        assert.equal(values.capacityKwh, 75);
        assert.equal(values.cellChemistry, 'Li-ion NMC');   // string slot stays a string
        assert.equal(values.recycledCoPct, 16);
        assert.equal(values.recycledLiPct, 6);
        assert.ok(!('recycledXxPct' in values), 'materials outside the registry have no slot');
        assert.ok(!('serialNumber' in values), 'non-provable payload fields must not leak into the tree');
        for (const k of Object.keys(values)) assert.ok(slotOf(k) >= 0, `${k} has no slot`);
    });

    it('extracts the measured slots from the guide attributes, decoded to scalars', () => {
        const withDyn = {
            ...payload,
            attributes: [
                { section: 'PerformanceAndDurability', attribute: 'CapacityFade', valueJson: '{"percentageValue":3.5,"percent":"%"}' },
                { section: 'PerformanceAndDurability', attribute: 'RemainingCapacity', valueJson: '{"amperehourMiliamperehourValue":196,"ampereHourMiliamperehour":"Ah"}' },
                { section: 'PerformanceAndDurability', attribute: 'NumberOfFullChargingAndDischargingCycles', valueJson: '39' },
                // Not a provable slot: must not leak into the tree.
                { section: 'PerformanceAndDurability', attribute: 'StateOfChargeSoC', valueJson: '{"percentageValue":71,"percent":"%"}' },
            ],
        };
        const values = provableValuesFromPayload(withDyn);
        assert.equal(values.CapacityFade, 3.5);
        assert.equal(values.RemainingCapacity, 196);
        assert.equal(values.NumberOfFullChargingAndDischargingCycles, 39);
        assert.ok(!('StateOfChargeSoC' in values));
    });

    it('survives an empty or malformed payload without throwing', () => {
        assert.deepEqual(provableValuesFromPayload({}), {});
        assert.deepEqual(provableValuesFromPayload(null), {});
        assert.deepEqual(provableValuesFromPayload({ batteries: [] }), {});
    });

    it('skips absent values rather than encoding them as zero', () => {
        const sparse = { batteries: [{ capacityKwh: 75, cycleLife: null, leadContentPpm: '' }], recycledMaterials: [] };
        const values = provableValuesFromPayload(sparse);
        assert.deepEqual(Object.keys(values), ['capacityKwh']);
    });
});

describe('payload cipher round-trip', () => {
    // Reconstructing an archived version depends on this: its older values live
    // nowhere but in that cipher.
    const KEY = process.env.ENCRYPTION_KEY;
    it('decrypts what it encrypted, and refuses another passport id', () => {
        process.env.ENCRYPTION_KEY = 'f'.repeat(64);
        try {
            const plain = JSON.stringify({ batteries: [{ capacityKwh: 75 }] });
            const cipher = encryptPayload(plain, 'BAT-1');
            assert.equal(decryptPayload(cipher, 'BAT-1'), plain);
            // The passport id is the HKDF salt, so it is bound to the payload.
            assert.throws(() => decryptPayload(cipher, 'BAT-2'));
            // Tampered bytes fail the GCM tag rather than returning garbage.
            const tampered = Buffer.from(cipher); tampered[tampered.length - 1] ^= 0xff;
            assert.throws(() => decryptPayload(tampered, 'BAT-1'));
            assert.throws(() => decryptPayload(Buffer.alloc(4), 'BAT-1'), /too short/);
        } finally {
            if (KEY === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = KEY;
        }
    });
});
