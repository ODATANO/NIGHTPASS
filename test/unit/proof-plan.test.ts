import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { proofCartPlan, claimKey, responseClaimKey } from '../../srv/lib/proof-plan';

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

    // --- mixed carts (setMembership, NIGHTGATE >= 0.15.0) --------------------

    it('pins the membership call shape: proveFieldMembership with 3 hex args', () => {
        const plan = proofCartPlan({
            payloadHash: H('a'),
            claims: [
                { fieldKey: H('b'), threshold: 4000000, op: 0 },
                { kind: 'membership', fieldKey: H('d'), setRoot: H('e') }
            ]
        });
        assert.deepEqual(plan.calls, [
            { circuit: 'proveFieldPredicate', args: [H('a'), H('b'), '4000000', '0'] },
            { circuit: 'proveFieldMembership', args: [H('a'), H('d'), H('e')] }
        ]);
    });

    it('dedups membership claims on (fieldKey, setRoot) without colliding with numeric keys', () => {
        const plan = proofCartPlan({
            payloadHash: H('a'),
            claims: [
                { kind: 'membership', fieldKey: H('b'), setRoot: H('c') },
                { kind: 'membership', fieldKey: H('B'), setRoot: H('C') }, // dup, case-insensitive
                { kind: 'membership', fieldKey: H('b'), setRoot: H('d') }, // different set
                { fieldKey: H('b'), threshold: 100, op: 0 }                 // numeric, same field: kept
            ]
        });
        assert.equal(plan.calls.length, 3);
        assert.equal(plan.dropped.length, 1);
        // Key namespaces are provably disjoint: 'm' can never be an
        // all-digits threshold.
        assert.equal(claimKey({ kind: 'membership', fieldKey: H('b'), setRoot: H('c') }), `${H('b')}|m|${H('c')}`);
        assert.equal(claimKey({ fieldKey: H('b'), threshold: 100, op: 0 }), `${H('b')}|100|0`);
    });

    it('legacy claims without a kind stay byte-identical predicate claims', () => {
        const legacy = proofCartPlan({ payloadHash: H('a'), claims: [{ fieldKey: H('b'), threshold: 5, op: 1 }] });
        assert.deepEqual(legacy.calls, [{ circuit: 'proveFieldPredicate', args: [H('a'), H('b'), '5', '1'] }]);
    });

    it('responseClaimKey matches on both sides of the paId join, per kind', () => {
        // Server-side claimMeta and the NIGHTGATE response MUST produce the
        // same string; a one-component drift makes the join miss silently.
        assert.equal(
            responseClaimKey({ fieldKey: H('B'), predicate: 'setMembership', setRoot: H('C') }),
            responseClaimKey({ fieldKey: H('b'), predicate: 'setMembership', setRoot: H('c'), threshold: null })
        );
        assert.equal(
            responseClaimKey({ fieldKey: H('b'), predicate: 'lessOrEqual', threshold: 4000 }),
            `${H('b')}|4000|lessOrEqual`
        );
        // Missing kind-specific component = no key, never a partial one.
        assert.equal(responseClaimKey({ fieldKey: H('b'), predicate: 'setMembership' }), null);
        assert.equal(responseClaimKey({ fieldKey: H('b'), predicate: 'lessOrEqual' }), null);
    });

    it('rejects a membership claim with a bad setRoot', () => {
        assert.throws(
            () => proofCartPlan({ payloadHash: H('a'), claims: [{ kind: 'membership', fieldKey: H('b'), setRoot: '0x12' }] }),
            /setRoot must be 32-byte hex/
        );
    });
});
