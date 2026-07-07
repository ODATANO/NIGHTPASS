import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import cds from '@sap/cds';
import { verifyAttestState, verifyGrantState, verifyPredicateState } from '../../srv/lib/state-verify';

/**
 * Crawler-free state verification (NIGHTGATE 0.5.0). The module talks to the
 * plugin via `cds.connect.to('nightgate').send(...)` and reads back
 * `midnight.DisclosureGrants` via `cds.db.read`. Both are stubbed here so the
 * verdict mapping is asserted in isolation, without a live chain or CAP context.
 *
 * The invariant under test: an on-chain effect that is present maps to
 * `confirmed`; everything else (absent, or the plugin unreachable) maps to
 * `unknown` and never `failed`. A not-yet-settled action keeps waiting.
 */

const ADDR = '02' + 'a'.repeat(62);
const PH = 'c3bda1f62f0bfba663f2572d1b74b4a57143bab5992527cf9641a8c6e588b465';
const GRANTEE = 'ff'.repeat(32);

const origConnectTo = cds.connect.to;
const origDb = Object.getOwnPropertyDescriptor(cds, 'db');

/** Stub `cds.connect.to('nightgate')` with a `send` that runs `sendImpl`. */
function stubNightgate(sendImpl: (event: string, data: any) => Promise<any>): void {
    (cds.connect as any).to = async () => ({ send: sendImpl });
}
/** Stub `cds.db.read(...).columns(...).where(...)` to resolve `rows`. */
function stubDbRead(rows: any[]): void {
    Object.defineProperty(cds, 'db', {
        configurable: true,
        value: { read: () => ({ columns: () => ({ where: async () => rows }) }) }
    });
}

afterEach(() => {
    (cds.connect as any).to = origConnectTo;
    if (origDb) Object.defineProperty(cds, 'db', origDb);
});

describe('verifyAttestState', () => {
    it('confirms when the payload hash is attested on-chain', async () => {
        stubNightgate(async () => ({ verified: true, attested: true }));
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: PH }), 'confirmed');
    });

    it('stays unknown (not failed) when the attestation is absent', async () => {
        stubNightgate(async () => ({ verified: false, attested: false }));
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: PH }), 'unknown');
    });

    it('stays unknown when the plugin is unreachable', async () => {
        stubNightgate(async () => { throw new Error('no live provider'); });
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: PH }), 'unknown');
    });

    it('is unknown (and makes no call) when inputs are missing', async () => {
        let called = false;
        stubNightgate(async () => { called = true; return { verified: true }; });
        assert.equal(await verifyAttestState({ contractAddress: '', payloadHash: PH }), 'unknown');
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: '' }), 'unknown');
        assert.equal(called, false);
    });
});

describe('verifyGrantState', () => {
    it('confirms a grant once its row is active on-chain', async () => {
        stubNightgate(async () => ({ active: 1 }));
        stubDbRead([{ active: true }]);
        assert.equal(await verifyGrantState({ contractAddress: ADDR, payloadHash: PH, grantee: GRANTEE, op: 'grant' }), 'confirmed');
    });

    it('keeps a grant pending while no active row exists yet', async () => {
        stubNightgate(async () => ({ active: 0 }));
        stubDbRead([]);
        assert.equal(await verifyGrantState({ contractAddress: ADDR, payloadHash: PH, grantee: GRANTEE, op: 'grant' }), 'unknown');
    });

    it('confirms a revoke once no active grant remains', async () => {
        stubNightgate(async () => ({ active: 0 }));
        stubDbRead([]);
        assert.equal(await verifyGrantState({ contractAddress: ADDR, payloadHash: PH, grantee: GRANTEE, op: 'revoke' }), 'confirmed');
    });

    it('keeps a revoke pending while the grant is still active', async () => {
        stubNightgate(async () => ({ active: 1 }));
        stubDbRead([{ active: true }]);
        assert.equal(await verifyGrantState({ contractAddress: ADDR, payloadHash: PH, grantee: GRANTEE, op: 'revoke' }), 'unknown');
    });

    it('stays unknown when the reindex call fails', async () => {
        stubNightgate(async () => { throw new Error('no live provider'); });
        stubDbRead([{ active: true }]);
        assert.equal(await verifyGrantState({ contractAddress: ADDR, payloadHash: PH, grantee: GRANTEE, op: 'grant' }), 'unknown');
    });
});

const FIELDKEY = 'ab'.repeat(32);

describe('verifyPredicateState', () => {
    it('confirms when the vault recorded a true result for the claim', async () => {
        stubNightgate(async () => ({ verified: true, proven: true }));
        assert.equal(
            await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, fieldKey: FIELDKEY, predicate: 'lessOrEqual', threshold: 4000 }),
            'confirmed'
        );
    });

    it('passes fieldKey/predicate/threshold through to the plugin verbatim', async () => {
        let seen: any = null;
        stubNightgate(async (_e, data) => { seen = data; return { verified: true }; });
        await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, fieldKey: FIELDKEY, predicate: 'greaterOrEqual', threshold: 60000 });
        assert.equal(seen.fieldKey, FIELDKEY);
        assert.equal(seen.predicate, 'greaterOrEqual');
        assert.equal(seen.threshold, 60000); // already-scaled, not re-scaled
    });

    it('stays unknown (not failed) when the result is absent', async () => {
        stubNightgate(async () => ({ verified: false, proven: false }));
        assert.equal(
            await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, fieldKey: FIELDKEY, predicate: 'lessOrEqual', threshold: 4000 }),
            'unknown'
        );
    });

    it('stays unknown when the plugin is unreachable', async () => {
        stubNightgate(async () => { throw new Error('no live provider'); });
        assert.equal(
            await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, fieldKey: FIELDKEY, predicate: 'lessOrEqual', threshold: 4000 }),
            'unknown'
        );
    });

    it('is unknown (and makes no call) when inputs are missing', async () => {
        let called = false;
        stubNightgate(async () => { called = true; return { verified: true }; });
        assert.equal(await verifyPredicateState({ contractAddress: '', payloadHash: PH, predicate: 'lessOrEqual', threshold: 1 }), 'unknown');
        assert.equal(called, false);
    });
});
