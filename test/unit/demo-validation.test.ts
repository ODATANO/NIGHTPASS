import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateDemoInput, validNickname } from '../../srv/lib/demo-validation';
import { encryptSecret, decryptSecret } from '../../srv/lib/demo-crypto';

const GOOD = {
    model: 'TryCell EV-1', manufacturer: 'DemoWorks GmbH',
    weightKg: 300, performanceClass: 'B', co2Kg: 3900, proveThreshold: 4000
};

describe('demo input validation', () => {
    test('accepts a plausible passport and normalizes numbers', () => {
        const r = validateDemoInput({ ...GOOD, weightKg: '300', co2Kg: '3900' });
        assert.equal(r.ok, true);
        assert.equal(r.value?.weightKg, 300);
        assert.equal(r.value?.co2Kg, 3900);
    });

    test('rejects out-of-charset text (it becomes public explorer content)', () => {
        assert.equal(validateDemoInput({ ...GOOD, model: '<script>alert(1)</script>' }).ok, false);
        assert.equal(validateDemoInput({ ...GOOD, manufacturer: 'x' }).ok, false); // too short
        assert.equal(validateDemoInput({ ...GOOD, model: 'a'.repeat(41) }).ok, false);
    });

    test('rejects numbers outside the plausible ranges', () => {
        assert.equal(validateDemoInput({ ...GOOD, weightKg: 0 }).ok, false);
        assert.equal(validateDemoInput({ ...GOOD, co2Kg: 'NaN' }).ok, false);
    });

    test('performance class is a strict A-E enum (case-normalized)', () => {
        assert.equal(validateDemoInput({ ...GOOD, performanceClass: 'e' }).value?.performanceClass, 'E');
        assert.equal(validateDemoInput({ ...GOOD, performanceClass: 'F' }).ok, false);
        assert.equal(validateDemoInput({ ...GOOD, performanceClass: 'AB' }).ok, false);
        assert.equal(validateDemoInput({ ...GOOD, performanceClass: '' }).ok, false);
    });

    test('rejects a claim that would be FALSE (co2 above the threshold)', () => {
        const r = validateDemoInput({ ...GOOD, co2Kg: 4500, proveThreshold: 4000 });
        assert.equal(r.ok, false);
        assert.match(r.errors.join(' '), /TRUE claim/);
    });

    test('nickname is optional and charset-capped', () => {
        assert.equal(validNickname(undefined), null);
        assert.equal(validNickname('  '), null);
        assert.equal(validNickname('Maxi_23'), 'Maxi_23');
        assert.equal(validNickname('<img>'), null);
    });
});

describe('demo secret crypto', () => {
    test('round-trips and binds to the context', () => {
        const ct = encryptSecret('ab'.repeat(64), 'tester-1');
        assert.equal(decryptSecret(ct, 'tester-1'), 'ab'.repeat(64));
        // A different context derives a different key: decrypt must fail.
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
