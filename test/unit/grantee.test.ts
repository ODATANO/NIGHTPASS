import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { granteeIdForDid } from '../../srv/lib/grantee';

describe('granteeIdForDid', () => {
    it('is sha256(utf8(did)) as 64-hex (must match NIGHTGATE deriveGranteeId)', () => {
        const did = 'did:web:recycler.example';
        const expected = createHash('sha256').update(Buffer.from(did, 'utf8')).digest('hex');
        assert.equal(granteeIdForDid(did), expected);
        assert.match(granteeIdForDid(did), /^[0-9a-f]{64}$/);
    });

    it('is deterministic and distinct per DID', () => {
        assert.equal(granteeIdForDid('BPNL0001'), granteeIdForDid('BPNL0001'));
        assert.notEqual(granteeIdForDid('BPNL0001'), granteeIdForDid('BPNL0002'));
    });

    it('rejects an empty DID', () => {
        assert.throws(() => granteeIdForDid(''), /did is required/);
    });
});
