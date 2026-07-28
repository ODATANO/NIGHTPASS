import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateDiligenceUpload, decodeUpload, sha256Hex, MAX_UPLOAD_BYTES } from '../../srv/lib/diligence-upload';

describe('validateDiligenceUpload', () => {
    it('accepts a pdf within the size cap', () => {
        assert.deepEqual(validateDiligenceUpload('report.pdf', 'application/pdf', 1024), { ok: true });
    });
    it('rejects unsupported mime types', () => {
        assert.equal(validateDiligenceUpload('x.exe', 'application/x-msdownload', 10).ok, false);
        assert.equal(validateDiligenceUpload('x.html', 'text/html', 10).ok, false);
    });
    it('rejects path separators in the file name', () => {
        assert.equal(validateDiligenceUpload('../../etc/passwd', 'application/pdf', 10).ok, false);
        assert.equal(validateDiligenceUpload('a\\b.pdf', 'application/pdf', 10).ok, false);
    });
    it('rejects empty and oversized uploads', () => {
        assert.equal(validateDiligenceUpload('a.pdf', 'application/pdf', 0).ok, false);
        assert.equal(validateDiligenceUpload('a.pdf', 'application/pdf', MAX_UPLOAD_BYTES + 1).ok, false);
    });
});

describe('decodeUpload', () => {
    it('round-trips plain base64 and data-url prefixed input', () => {
        const b64 = Buffer.from('hello dpp').toString('base64');
        assert.equal(decodeUpload(b64)?.toString(), 'hello dpp');
        assert.equal(decodeUpload(`data:application/pdf;base64,${b64}`)?.toString(), 'hello dpp');
    });
    it('rejects empty and malformed input', () => {
        assert.equal(decodeUpload(''), null);
        assert.equal(decodeUpload('not@@base64!!'), null);
    });
});

describe('sha256Hex', () => {
    it('matches the known vector for "abc"', () => {
        assert.equal(sha256Hex(Buffer.from('abc')),
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});
