import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    sortKeys, canonicalize, blake2b256Hex, hashPayload,
    scaleValue, fieldKeyHex, VALUE_SCALE, encryptPayload
} from '../../srv/lib/passport-anchor';

describe('canonicalize + hashPayload', () => {
    it('sorts object keys recursively and deterministically', () => {
        const a = { b: 1, a: { z: [3, { y: 2, x: 1 }], k: 'v' } };
        const b = { a: { k: 'v', z: [3, { x: 1, y: 2 }] }, b: 1 };
        assert.equal(canonicalize(a), canonicalize(b));
        assert.deepEqual(sortKeys([{ b: 1, a: 2 }]), [{ a: 2, b: 1 }]);
    });

    it('preserves array order (arrays are significant, not sorted)', () => {
        assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }));
    });

    it('hashPayload is a stable 64-hex over the canonical form', () => {
        const h1 = hashPayload({ b: 1, a: 2 }).payloadHash;
        const h2 = hashPayload({ a: 2, b: 1 }).payloadHash;
        assert.equal(h1, h2);
        assert.match(h1, /^[0-9a-f]{64}$/);
    });
});

describe('blake2b256Hex', () => {
    it('matches the blake2b-256 empty-string vector', () => {
        assert.equal(
            blake2b256Hex(''),
            '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8'
        );
    });
});

describe('scaleValue + fieldKeyHex', () => {
    it('scales to integer milli-units', () => {
        assert.equal(scaleValue(3.412), Math.round(3.412 * VALUE_SCALE));
        assert.equal(scaleValue('16.5'), 16500);
    });

    it('fieldKeyHex is the blake2b-256 of the field name', () => {
        assert.equal(fieldKeyHex('carbonFootprintKgCO2'), blake2b256Hex('carbonFootprintKgCO2'));
        assert.match(fieldKeyHex('capacityKwh'), /^[0-9a-f]{64}$/);
    });
});

describe('encryptPayload', () => {
    it('lays out iv(12) || tag(16) || ciphertext and is nonce-randomized', () => {
        const pt = 'hello passport';
        const a = encryptPayload(pt, 'BAT-PREVIEW-0001');
        const b = encryptPayload(pt, 'BAT-PREVIEW-0001');
        assert.equal(a.length, 12 + 16 + Buffer.byteLength(pt, 'utf8'));
        assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12)); // random iv per call
    });
});
