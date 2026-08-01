import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anchorCallPlan } from '../../srv/lib/anchor-plan';

// The plan is consumed by BOTH the server batch path (passport-anchor.ts) and
// the browser connector's anchorBatch. These pins are the drift guard: any
// change to order, circuit names or argument shapes must trip them.

const H = (c: string) => c.repeat(64);

describe('anchorCallPlan', () => {
    it('pins the full plan: attest -> bindPassport -> anchorContentRoot with exact arg shapes', () => {
        const plan = anchorCallPlan({
            payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c'), contentRoot: H('d')
        });
        assert.deepEqual(plan, [
            { circuit: 'attest',            args: [H('a'), H('b')] },
            { circuit: 'bindPassport',      args: [H('c'), H('a')] },
            { circuit: 'anchorContentRoot', args: [H('a'), H('d')] }
        ]);
    });

    it('omits anchorContentRoot when no content root is given (empty string counts as absent)', () => {
        const noRoot = anchorCallPlan({ payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c') });
        assert.deepEqual(noRoot.map(c => c.circuit), ['attest', 'bindPassport']);
        const emptyRoot = anchorCallPlan({
            payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c'), contentRoot: ''
        });
        assert.deepEqual(emptyRoot.map(c => c.circuit), ['attest', 'bindPassport']);
    });

    it('rejects non-64-hex arguments (Bytes<32> circuit args only)', () => {
        assert.throws(
            () => anchorCallPlan({ payloadHash: 'xyz', metadataHash: H('b'), passportIdHash: H('c') }),
            /payloadHash must be 32-byte hex/
        );
        assert.throws(
            () => anchorCallPlan({ payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c'), contentRoot: '0x12' }),
            /contentRoot must be 32-byte hex/
        );
    });
});
