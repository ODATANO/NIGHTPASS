import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { proofCartPlan } from '../../srv/lib/proof-plan';

// The plan is consumed by the browser connector's proveFieldPredicateBatch
// and (once the NIGHTGATE batch pendant ships) the server proof path. These
// pins are the drift guard: any change to circuit name, argument order or
// dedup semantics must trip them.

const H = (c: string) => c.repeat(64);

describe('proofCartPlan', () => {
    it('pins the call shape: one proveFieldPredicate per claim, args in signature order as strings', () => {
        const plan = proofCartPlan({
            payloadHash: H('a'),
            claims: [
                { fieldKey: H('b'), threshold: 4000000, op: 0 },
                { fieldKey: H('c'), threshold: '16000', op: 1 }
            ]
        });
        assert.deepEqual(plan.calls, [
            { circuit: 'proveFieldPredicate', args: [H('a'), H('b'), '4000000', '0'] },
            { circuit: 'proveFieldPredicate', args: [H('a'), H('c'), '16000', '1'] }
        ]);
        assert.equal(plan.claims.length, 2);
        assert.deepEqual(plan.dropped, []);
    });

    it('drops exact duplicate claims (case-insensitive fieldKey) and reports them', () => {
        const plan = proofCartPlan({
            payloadHash: H('a'),
            claims: [
                { fieldKey: H('b'), threshold: 100, op: 0 },
                { fieldKey: H('B'), threshold: '100', op: 0 },
                { fieldKey: H('b'), threshold: 100, op: 1 }
            ]
        });
        assert.equal(plan.calls.length, 2);
        assert.equal(plan.dropped.length, 1);
        assert.deepEqual(plan.calls.map(c => c.args[3]), ['0', '1']);
    });

    it('rejects an empty cart, bad hex, fractional/negative thresholds and unknown ops', () => {
        assert.throws(() => proofCartPlan({ payloadHash: H('a'), claims: [] }), /cart is empty/);
        assert.throws(
            () => proofCartPlan({ payloadHash: 'xyz', claims: [{ fieldKey: H('b'), threshold: 1, op: 0 }] }),
            /payloadHash must be 32-byte hex/
        );
        assert.throws(
            () => proofCartPlan({ payloadHash: H('a'), claims: [{ fieldKey: '0x12', threshold: 1, op: 0 }] }),
            /fieldKey must be 32-byte hex/
        );
        assert.throws(
            () => proofCartPlan({ payloadHash: H('a'), claims: [{ fieldKey: H('b'), threshold: 1.5, op: 0 }] }),
            /threshold must be a non-negative integer/
        );
        assert.throws(
            () => proofCartPlan({ payloadHash: H('a'), claims: [{ fieldKey: H('b'), threshold: -1, op: 0 }] }),
            /threshold must be a non-negative integer/
        );
        assert.throws(
            () => proofCartPlan({ payloadHash: H('a'), claims: [{ fieldKey: H('b'), threshold: 1, op: 2 as 0 }] }),
            /op must be 0/
        );
    });
});
