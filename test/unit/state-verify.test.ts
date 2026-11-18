import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAttestState, verifyGrantState, verifyPredicateState, recordSelectorArgs, resolveAnchorAttester } from '../../srv/lib/state-verify';

/**
 * State verification. The module reads the NIGHTGATE API's verify service;
 * the HTTP call is stubbed here so the verdict mapping is asserted in
 * isolation, without a live chain.
 *
 * The invariant under test: an on-chain effect that is present maps to
 * `confirmed`; everything else (absent, or the API unreachable) maps to
 * `unknown` and never `failed`. A not-yet-settled action keeps waiting.
 */

const ADDR = '02' + 'a'.repeat(62);
const PH = 'c3bda1f62f0bfba663f2572d1b74b4a57143bab5992527cf9641a8c6e588b465';
const GRANTEE = 'ff'.repeat(32);
const ATT = '11'.repeat(32);
const DOC = '22'.repeat(32);

process.env.NIGHTGATE_API_URL = 'https://ng.test';
const down = async (): Promise<any> => { throw new Error('no stub'); };
let answer: (event: string, data: any) => Promise<any> = down;

// The verify client keeps the fetch it was created with, so one fake stays installed and the tests swap its answer.
globalThis.fetch = (async (url: unknown) => {
    const m = /\/([A-Za-z]+)\((.*)\)$/.exec(decodeURIComponent(String(url)));
    const data: Record<string, unknown> = {};
    for (const part of (m?.[2] ?? '').match(/[A-Za-z]+=(?:'(?:[^']|'')*'|[^,]+)/g) ?? []) {
        const i = part.indexOf('=');
        const raw = part.slice(i + 1);
        data[part.slice(0, i)] = raw.startsWith("'") ? raw.slice(1, -1) : raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    }
    try {
        return new Response(JSON.stringify(await answer(m?.[1] ?? '', data)), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: String((e as Error).message) } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
}) as typeof fetch;

/** Answers the next state reads with `sendImpl(function name, parameters)`. */
function stubNightgate(sendImpl: (event: string, data: any) => Promise<any>): void {
    answer = sendImpl;
}

afterEach(() => { answer = down; });

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
    const GRANT = { contractAddress: ADDR, payloadHash: PH, attesterId: ATT, grantee: GRANTEE };

    it('confirms a grant once the vault holds it, and names the record and the grantee', async () => {
        let seen: any = null;
        stubNightgate(async (event, data) => { seen = { event, data }; return { verified: true, granted: true, level: 1 }; });
        assert.equal(await verifyGrantState({ ...GRANT, op: 'grant' }), 'confirmed');
        assert.deepEqual(seen, { event: 'verifyDisclosureState', data: { ...GRANT, compiledArtifactRef: 'attestation-vault' } });
    });

    it('keeps a grant pending while the vault holds none yet', async () => {
        stubNightgate(async () => ({ verified: false, granted: false, level: null }));
        assert.equal(await verifyGrantState({ ...GRANT, op: 'grant' }), 'unknown');
    });

    it('confirms a revoke once the grant is gone from a record that is still there', async () => {
        stubNightgate(async (event) => (event === 'verifyDisclosureState'
            ? { verified: false, granted: false, level: null }
            : { verified: true, attested: true }));
        assert.equal(await verifyGrantState({ ...GRANT, op: 'revoke' }), 'confirmed');
    });

    it('keeps a revoke pending when the read finds no record at all', async () => {
        stubNightgate(async (event) => (event === 'verifyDisclosureState'
            ? { verified: false, granted: false, level: null }
            : { verified: false, attested: false }));
        assert.equal(await verifyGrantState({ ...GRANT, op: 'revoke' }), 'unknown');
    });

    it('keeps a revoke pending while the grant is still there', async () => {
        stubNightgate(async () => ({ verified: true, granted: true, level: 2 }));
        assert.equal(await verifyGrantState({ ...GRANT, op: 'revoke' }), 'unknown');
    });

    it('stays unknown when the read fails or the record has no attester', async () => {
        stubNightgate(async () => { throw new Error('no live provider'); });
        assert.equal(await verifyGrantState({ ...GRANT, op: 'grant' }), 'unknown');
        stubNightgate(async () => ({ granted: true }));
        assert.equal(await verifyGrantState({ ...GRANT, attesterId: null, op: 'grant' }), 'unknown');
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
