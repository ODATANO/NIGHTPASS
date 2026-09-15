import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anchorTxPlan, anchorCallPlan } from '../../srv/lib/anchor-plan';

// The plan is consumed by the plugin lane, the remote lane and the browser
// connector's anchorBatch. These pins are the drift guard: any change to the
// transaction split, order, circuit names or argument shapes must trip them.

const H = (c: string) => c.repeat(64);
const FULL = { payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c'), contentRoot: H('d'), schemaId: H('e') };

describe('anchorTxPlan', () => {
    it('anchors in ONE transaction: attest, anchorContentRoot, bindDocument (lineage 4)', () => {
        assert.deepEqual(anchorTxPlan(FULL), [
            {
                label: 'attest+anchorContentRoot+bindDocument',
                calls: [
                    { circuit: 'attest', args: [H('a'), H('b')] },
                    { circuit: 'anchorContentRoot', args: [H('a'), H('d'), H('e')] },
                    { circuit: 'bindDocument', args: [H('c'), H('a')] }
                ]
            }
        ]);
    });

    it('keeps the fallible bindDocument last (ledger causality rule)', () => {
        const [tx] = anchorTxPlan(FULL);
        assert.equal(tx.calls[tx.calls.length - 1].circuit, 'bindDocument');
        assert.equal(tx.calls[0].circuit, 'attest');
    });

    it('omits anchorContentRoot when no content root is given (empty string counts as absent)', () => {
        const noRoot = anchorTxPlan({ payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c') });
        assert.deepEqual(noRoot.map((t) => t.label), ['attest+bindDocument']);
        const emptyRoot = anchorTxPlan({ ...FULL, contentRoot: '' });
        assert.deepEqual(emptyRoot.map((t) => t.label), ['attest+bindDocument']);
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
            ['attest', 'anchorContentRoot', 'bindDocument']
        );
    });
});
