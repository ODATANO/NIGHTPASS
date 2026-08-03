import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sweepAction, verdictToStatus, STUCK_AFTER_MS } from '../../srv/lib/stuck-rows';

describe('sweepAction', () => {
    it('leaves a young row alone (a detached runner may still own it)', () => {
        assert.deepEqual(sweepAction({ ageMs: 60_000, checkable: true }), { kind: 'leave' });
        assert.deepEqual(sweepAction({ ageMs: STUCK_AFTER_MS - 1, checkable: false }), { kind: 'leave' });
    });

    it('re-checks an old row that carries a transaction hash', () => {
        assert.deepEqual(sweepAction({ ageMs: STUCK_AFTER_MS + 1, checkable: true }), { kind: 'recheck' });
    });

    it('fails an old row that never reached the chain', () => {
        const action = sweepAction({ ageMs: 60 * 60_000, checkable: false });
        assert.equal(action.kind, 'fail');
        assert.match((action as { reason: string }).reason, /restart/);
    });

    it('honours a caller-supplied threshold', () => {
        assert.equal(sweepAction({ ageMs: 5_000, checkable: true }, 1_000).kind, 'recheck');
    });
});

describe('verdictToStatus', () => {
    it('confirms a row the chain actually shows', () => {
        assert.deepEqual(verdictToStatus('confirmed'), { status: 'succeeded' });
    });

    it('fails a row the chain does not show', () => {
        assert.equal(verdictToStatus('failed').status, 'failed');
    });

    // The load-bearing property: never report success we cannot prove.
    it('fails an UNKNOWN verdict rather than claiming success', () => {
        const out = verdictToStatus('unknown');
        assert.equal(out.status, 'failed');
        assert.match(out.reason ?? '', /unconfirmed/);
    });
});
