import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import cds from '@sap/cds';
import { verifyAttestState, verifyGrantState, verifyPredicateState, recordSelectorArgs, resolveAnchorAttester } from '../../srv/lib/state-verify';

/**
 * Crawler-free state verification. The module talks to the
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
const ATT = '11'.repeat(32);
const DOC = '22'.repeat(32);

const origConnectTo = cds.connect.to;
const origDb = Object.getOwnPropertyDescriptor(cds, 'db');

/**
 * Stub `cds.connect.to('nightgate')` with a `send` that runs `sendImpl`,
 * reachable directly and through the technical-user `tx` the verify reader uses.
 */
function stubNightgate(sendImpl: (event: string, data: any) => Promise<any>): void {
    const svc = { send: sendImpl };
    (cds.connect as any).to = async () => ({ ...svc, tx: async (_ctx: unknown, cb: (tx: typeof svc) => Promise<any>) => cb(svc) });
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

describe('recordSelectorArgs', () => {
    it('names the record by attester + payload, else by the bound document id, else not at all', () => {
        assert.deepEqual(recordSelectorArgs({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT, documentId: DOC }),
            { contractAddress: ADDR, attesterId: ATT, payloadHash: PH });
        assert.deepEqual(recordSelectorArgs({ contractAddress: ADDR, payloadHash: PH, documentId: DOC }),
            { contractAddress: ADDR, documentId: DOC, payloadHash: PH });
        assert.equal(recordSelectorArgs({ contractAddress: ADDR, payloadHash: PH }), null);
        assert.equal(recordSelectorArgs({ contractAddress: ADDR, payloadHash: PH, attesterId: 'short' }), null);
        assert.equal(recordSelectorArgs({ contractAddress: '', payloadHash: PH, attesterId: ATT }), null);
    });
});

describe('resolveAnchorAttester', () => {
    it('returns the attester the binding read names, only for an attested record', async () => {
        let seen: any = null;
        stubNightgate(async (_e, data) => { seen = data; return { attested: true, attesterId: ATT.toUpperCase() }; });
        assert.equal(await resolveAnchorAttester({ contractAddress: ADDR, documentId: DOC, payloadHash: PH }), ATT);
        assert.deepEqual(seen, { contractAddress: ADDR, documentId: DOC, payloadHash: PH, compiledArtifactRef: 'attestation-vault' });
        stubNightgate(async () => ({ attested: false }));
        assert.equal(await resolveAnchorAttester({ contractAddress: ADDR, documentId: DOC, payloadHash: PH }), null);
        stubNightgate(async () => { throw new Error('down'); });
        assert.equal(await resolveAnchorAttester({ contractAddress: ADDR, documentId: DOC, payloadHash: PH }), null);
    });
});

describe('verifyAttestState', () => {
    it('passes the record selector through (attester preferred, document id as fallback)', async () => {
        const seen: any[] = [];
        stubNightgate(async (_e, data) => { seen.push(data); return { verified: true }; });
        await verifyAttestState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT, documentId: DOC });
        await verifyAttestState({ contractAddress: ADDR, payloadHash: PH, documentId: DOC });
        assert.deepEqual(seen[0], { contractAddress: ADDR, attesterId: ATT, payloadHash: PH, compiledArtifactRef: 'attestation-vault' });
        assert.deepEqual(seen[1], { contractAddress: ADDR, documentId: DOC, payloadHash: PH, compiledArtifactRef: 'attestation-vault' });
    });

    it('is unknown (no call) when neither attester nor document id names the record', async () => {
        let called = false;
        stubNightgate(async () => { called = true; return { verified: true }; });
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: PH, attesterId: '', documentId: '' }), 'unknown');
        assert.equal(called, false);
    });
    it('confirms when the payload hash is attested on-chain', async () => {
        stubNightgate(async () => ({ verified: true, attested: true }));
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT }), 'confirmed');
    });

    it('stays unknown (not failed) when the attestation is absent', async () => {
        stubNightgate(async () => ({ verified: false, attested: false }));
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT }), 'unknown');
    });

    it('stays unknown when the plugin is unreachable', async () => {
        stubNightgate(async () => { throw new Error('no live provider'); });
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT }), 'unknown');
    });

    it('is unknown (and makes no call) when inputs are missing', async () => {
        let called = false;
        stubNightgate(async () => { called = true; return { verified: true }; });
        assert.equal(await verifyAttestState({ contractAddress: '', payloadHash: PH, attesterId: ATT }), 'unknown');
        assert.equal(await verifyAttestState({ contractAddress: ADDR, payloadHash: '', attesterId: ATT }), 'unknown');
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
            await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT, fieldKey: FIELDKEY, predicate: 'lessOrEqual', threshold: 4000 }),
            'confirmed'
        );
    });

    it('passes fieldKey/predicate/threshold through to the plugin verbatim', async () => {
        let seen: any = null;
        stubNightgate(async (_e, data) => { seen = data; return { verified: true }; });
        await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT, fieldKey: FIELDKEY, predicate: 'greaterOrEqual', threshold: 60000 });
        assert.equal(seen.fieldKey, FIELDKEY);
        assert.equal(seen.attesterId, ATT);
        assert.equal(seen.predicate, 'greaterOrEqual');
        assert.equal(seen.threshold, 60000); // already-scaled, not re-scaled
    });

    it('stays unknown (not failed) when the result is absent', async () => {
        stubNightgate(async () => ({ verified: false, proven: false }));
        assert.equal(
            await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT, fieldKey: FIELDKEY, predicate: 'lessOrEqual', threshold: 4000 }),
            'unknown'
        );
    });

    it('stays unknown when the plugin is unreachable', async () => {
        stubNightgate(async () => { throw new Error('no live provider'); });
        assert.equal(
            await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, attesterId: ATT, fieldKey: FIELDKEY, predicate: 'lessOrEqual', threshold: 4000 }),
            'unknown'
        );
    });

    it('is unknown (and makes no call) when inputs are missing, the attester included', async () => {
        let called = false;
        stubNightgate(async () => { called = true; return { verified: true }; });
        assert.equal(await verifyPredicateState({ contractAddress: '', payloadHash: PH, attesterId: ATT, predicate: 'lessOrEqual', threshold: 1 }), 'unknown');
        assert.equal(await verifyPredicateState({ contractAddress: ADDR, payloadHash: PH, fieldKey: FIELDKEY, predicate: 'lessOrEqual', threshold: 1 }), 'unknown');
        assert.equal(called, false);
    });
});
