import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anchorTxPlan, anchorCallPlan } from '../../srv/lib/anchor-plan';

// The plan is consumed by BOTH the server anchor path (passport-anchor.ts) and
// the browser connector's anchorBatch. These pins are the drift guard: any
// change to the transaction split, order, circuit names or argument shapes
// must trip them.

const H = (c: string) => c.repeat(64);
const FULL = { payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c'), contentRoot: H('d'), schemaId: H('e') };

describe('anchorTxPlan', () => {
    it('splits the anchor into attest, then the rest as one batch', () => {
        assert.deepEqual(anchorTxPlan(FULL), [
            { label: 'attest', calls: [{ circuit: 'attest', args: [H('a'), H('b')] }] },
            {
                label: 'anchorContentRoot+bindPassport',
                calls: [
                    { circuit: 'anchorContentRoot', args: [H('a'), H('d'), H('e')] },
                    { circuit: 'bindPassport', args: [H('c'), H('a')] }
                ]
            }
        ]);
    });

    it('keeps attest alone: it updates the attestation-sequence cell (1010/188)', () => {
        for (const tx of anchorTxPlan(FULL)) {
            if (tx.calls.some((c) => c.circuit === 'attest')) {
                assert.equal(tx.calls.length, 1,
                    'a cell-updating call followed by a later intent is rejected by the ledger sequencing check');
            }
        }
    });

    it('keeps the cell-UPDATING bindPassport last within its transaction', () => {
        const [, rest] = anchorTxPlan(FULL);
        assert.equal(rest.calls[rest.calls.length - 1].circuit, 'bindPassport',
            'a re-anchor rebinds an existing cell; a later intent after it fails the sequencing check');
    });

    it('omits anchorContentRoot when no content root is given (empty string counts as absent)', () => {
        const noRoot = anchorTxPlan({ payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c') });
        assert.deepEqual(noRoot.map((t) => t.label), ['attest', 'bindPassport']);
        const emptyRoot = anchorTxPlan({ ...FULL, contentRoot: '' });
        assert.deepEqual(emptyRoot.map((t) => t.label), ['attest', 'bindPassport']);
    });

    it('refuses to anchor a content root without its schema id', () => {
        assert.throws(
            () => anchorTxPlan({ payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c'), contentRoot: H('d') }),
            /schemaId is required/
        );
    });

    it('rejects non-64-hex arguments (Bytes<32> circuit args only)', () => {
        assert.throws(
            () => anchorTxPlan({ payloadHash: 'xyz', metadataHash: H('b'), passportIdHash: H('c') }),
            /payloadHash must be 32-byte hex/
        );
        assert.throws(() => anchorTxPlan({ ...FULL, contentRoot: '0x12' }), /contentRoot must be 32-byte hex/);
        assert.throws(() => anchorTxPlan({ ...FULL, schemaId: 'nope' }), /schemaId must be 32-byte hex/);
    });
});

describe('anchorCallPlan', () => {
    it('flattens the transactions in apply order', () => {
        assert.deepEqual(
            anchorCallPlan(FULL).map((c) => c.circuit),
            ['attest', 'anchorContentRoot', 'bindPassport']
        );
    });
});
