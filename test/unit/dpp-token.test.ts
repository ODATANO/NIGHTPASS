import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mintDppToken, roleFromSignedToken } from '../../srv/lib/dpp-api';

describe('DPP conformance tokens', () => {
    it('round-trips a minted token to its role', () => {
        assert.equal(roleFromSignedToken(mintDppToken('authority')), 'authority');
        assert.equal(roleFromSignedToken(mintDppToken('economic_operator')), 'economic_operator');
    });

    // The whole point: before signing, any string SHAPED like a token granted
    // the role it claimed, so `bp.authority.x` was a full authority credential.
    it('rejects a forged self-describing token', () => {
        assert.equal(roleFromSignedToken('bp.authority.x'), undefined);
        assert.equal(roleFromSignedToken('bp.economic_operator.11111111-1111-1111-1111-111111111111'), undefined);
    });

    it('rejects a tampered signature or role', () => {
        const token = mintDppToken('public');
        const [prefix, role, uuid, sig] = token.split('.');
        assert.equal(roleFromSignedToken(`${prefix}.authority.${uuid}.${sig}`), undefined, 'role swap must not verify');
        assert.equal(roleFromSignedToken(`${prefix}.${role}.${uuid}.${'0'.repeat(32)}`), undefined, 'bad signature must not verify');
        assert.equal(roleFromSignedToken(`${prefix}.${role}.${uuid}`), undefined, 'unsigned must not verify');
    });

    it('rejects junk without throwing', () => {
        for (const junk of ['', 'bearer x', 'bp..', 'bp.a.b.c.d']) {
            assert.equal(roleFromSignedToken(junk), undefined);
        }
    });
});
