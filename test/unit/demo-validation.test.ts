import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateDemoInput, validNickname } from '../../srv/lib/demo-validation';
import { encryptSecret, decryptSecret } from '../../srv/lib/demo-crypto';

const BATTERY = {
    profile: 'battery',
    head: { model: 'TryCell EV-1', manufacturerId: 'DemoWorks GmbH', weightKg: 300, performanceClass: 'B' },
    claims: [{ field: 'carbonFootprintKgCO2', value: 3900, threshold: 4000 }],
};
const COMPONENT = {
    profile: 'component',
    head: { model: 'Nozzle forging DN 800', manufacturerId: 'DemoForge AG', weightKg: 1840, SafetyClass: '2' },
    claims: [{ field: 'cobaltContentPpm', value: 120, threshold: 200 }, { field: 'supplierId', member: 'QSL-0031' }],
};

describe('demo input validation', () => {
    test('accepts a plausible passport of either family and normalizes numbers', () => {
        const b = validateDemoInput({ ...BATTERY, head: { ...BATTERY.head, weightKg: '300' } });
        assert.equal(b.ok, true, b.errors.join('; '));
        assert.equal(b.value?.head.weightKg, 300);
        assert.equal(b.value?.profile.id, 'battery');
        const c = validateDemoInput(COMPONENT);
        assert.equal(c.ok, true, c.errors.join('; '));
        assert.equal(c.value?.head.SafetyClass, '2');
        assert.equal(c.value?.claims.length, 2);
    });

    test('defaults to the battery family and rejects unknown ones', () => {
        assert.equal(validateDemoInput({ ...BATTERY, profile: undefined }).value?.profile.id, 'battery');
        assert.equal(validateDemoInput({ ...BATTERY, profile: 'tyre' }).ok, false);
    });

    test('rejects out-of-charset text (it becomes public explorer content)', () => {
        const bad = (head: Record<string, unknown>) => validateDemoInput({ ...BATTERY, head: { ...BATTERY.head, ...head } }).ok;
        assert.equal(bad({ model: '<script>alert(1)</script>' }), false);
        assert.equal(bad({ manufacturerId: 'x' }), false);
        assert.equal(bad({ model: 'a'.repeat(41) }), false);
    });

    test('rejects numbers outside the plausible ranges', () => {
        assert.equal(validateDemoInput({ ...BATTERY, head: { ...BATTERY.head, weightKg: 0 } }).ok, false);
        assert.equal(validateDemoInput({ ...COMPONENT, head: { ...COMPONENT.head, weightKg: 'NaN' } }).ok, false);
    });

    test('select heads are a strict enum (case-normalized)', () => {
        assert.equal(validateDemoInput({ ...BATTERY, head: { ...BATTERY.head, performanceClass: 'b' } }).value?.head.performanceClass, 'B');
        assert.equal(validateDemoInput({ ...BATTERY, head: { ...BATTERY.head, performanceClass: 'F' } }).ok, false);
        assert.equal(validateDemoInput({ ...COMPONENT, head: { ...COMPONENT.head, SafetyClass: '4' } }).ok, false);
    });

    test('the primary claim is required and must be true', () => {
        assert.equal(validateDemoInput({ ...BATTERY, claims: [] }).ok, false);
        const r = validateDemoInput({ ...BATTERY, claims: [{ field: 'carbonFootprintKgCO2', value: 4100, threshold: 4000 }] });
        assert.equal(r.ok, false);
        assert.match(r.errors[0], /not at most/);
    });

    test('the second act is a battery feature', () => {
        assert.equal(validateDemoInput({ ...BATTERY, secondLife: 'true' }).value?.secondLife, true);
        assert.equal(validateDemoInput({ ...COMPONENT, secondLife: true }).ok, false);
        assert.equal(validateDemoInput(COMPONENT).value?.secondLife, false);
    });
});

describe('nickname', () => {
    test('accepts short plain names and rejects the rest', () => {
        assert.equal(validNickname(' Ada '), 'Ada');
        assert.equal(validNickname(''), null);
        assert.equal(validNickname('<b>'), null);
        assert.equal(validNickname('a'.repeat(25)), null);
    });
});

describe('demo secret crypto', () => {
    test('round-trips and binds to the context', () => {
        const ct = encryptSecret('ab'.repeat(64), 'tester-1');
        assert.equal(decryptSecret(ct, 'tester-1'), 'ab'.repeat(64));
        assert.throws(() => decryptSecret(ct, 'tester-2'));
    });

    test('unique ciphertexts per call (fresh IV)', () => {
        const a = encryptSecret('same', 'ctx');
        const b = encryptSecret('same', 'ctx');
        assert.notEqual(a, b);
        assert.equal(decryptSecret(a, 'ctx'), 'same');
        assert.equal(decryptSecret(b, 'ctx'), 'same');
    });
});
