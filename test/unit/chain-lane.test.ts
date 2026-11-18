import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProofCartError, prepareVaultCall, type ChainLane, type VaultCall, type VaultTxInput } from '../../srv/lib/chain-lane';
import { anchorPassport } from '../../srv/lib/passport-anchor';

// These pins hold the mapping from a planned vault call to the SDK's prepare
// helper fixed: helper name, argument names and the number conversions.

const H = (c: string) => c.repeat(64);
const SECRET = new Uint8Array(32).fill(7);

/** A stand-in for the SDK's call helpers that records which helper got which input. */
function fakeCalls() {
    const seen: Array<{ helper: string; input: Record<string, unknown> }> = [];
    const helper = (name: string) => (input: Record<string, unknown>) => {
        seen.push({ helper: name, input });
        return { circuitId: name, args: [], witnesses: {} };
    };
    const calls = new Proxy({}, { get: (_t, name) => helper(String(name)) }) as Parameters<typeof prepareVaultCall>[0];
    return { calls, seen };
}

describe('prepareVaultCall', () => {
    const cases: Array<[VaultCall, string, Record<string, unknown>]> = [
        [{ circuit: 'attest', args: [H('a'), H('b')] }, 'prepareAttest', { payloadHash: H('a'), metadataHash: H('b') }],
        [{ circuit: 'bindDocument', args: [H('d'), H('a')] }, 'prepareBindDocument', { documentId: H('d'), payloadHash: H('a') }],
        [{ circuit: 'anchorContentRoot', args: [H('a'), H('c'), H('e')] }, 'prepareAnchorContentRoot',
            { payloadHash: H('a'), contentRoot: H('c'), schemaId: H('e') }],
        [{ circuit: 'grantDisclosure', args: [H('a'), H('9'), '2'] }, 'prepareGrantDisclosure',
            { payloadHash: H('a'), grantee: H('9'), level: 2 }],
        [{ circuit: 'revokeDisclosure', args: [H('a'), H('9')] }, 'prepareRevokeDisclosure', { payloadHash: H('a'), grantee: H('9') }],
        [{ circuit: 'registerDocument', args: ['0', H('d'), H('1')] }, 'prepareRegisterDocument',
            { mode: 0, documentId: H('d'), ownerId: H('1') }]
    ];

    for (const [call, helper, input] of cases) {
        it(`${call.circuit} goes to ${helper} with the lane's secret`, () => {
            const { calls, seen } = fakeCalls();
            prepareVaultCall(calls, SECRET, call);
            assert.deepEqual(seen, [{ helper, input: { ...input, attestationSecret: SECRET } }]);
        });
    }

    it('refuses a circuit it does not know', () => {
        const { calls } = fakeCalls();
        assert.throws(() => prepareVaultCall(calls, SECRET, { circuit: 'mint', args: [] } as unknown as VaultCall), /unsupported vault circuit 'mint'/);
    });
});

describe('anchorPassport', () => {
    function fakeLane(): { lane: ChainLane; sent: VaultTxInput[] } {
        const sent: VaultTxInput[] = [];
        const lane: ChainLane = {
            attesterId: async () => H('1'),
            submitVaultTx: async (input) => { sent.push(input); return { txHash: 'tx-anchor', jobId: 'job-anchor' }; },
            submitProofCart: async () => { throw new Error('not used'); },
            submitComparison: async () => { throw new Error('not used'); },
            verifyClaimLanded: async () => false,
            dispose: async () => undefined
        };
        return { lane, sent };
    }

    it('submits attest, the content root and the binding as one transaction, in that order', async () => {
        const { lane, sent } = fakeLane();
        const steps: string[] = [];
        const out = await anchorPassport(lane, {
            payloadHash: H('a'), passportId: 'BAT-1', passportIdHash: H('d'), contractAddress: H('f'),
            contentRoot: H('c'), schemaId: H('e'),
            onStep: (s) => { steps.push(`${s.kind}:${s.txHash}:${s.jobId}`); }
        });
        assert.equal(out.attestationTxHash, 'tx-anchor');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].contractAddress, H('f'));
        assert.deepEqual(sent[0].tx.calls.map((c) => c.circuit), ['attest', 'anchorContentRoot', 'bindDocument']);
        assert.deepEqual(steps, ['attest:tx-anchor:job-anchor', 'anchorContentRoot:tx-anchor:job-anchor', 'bindDocument:tx-anchor:job-anchor']);
    });

    it('leaves the content root out when none is given, and refuses a root without its schema id', async () => {
        const { lane, sent } = fakeLane();
        await anchorPassport(lane, { payloadHash: H('a'), passportId: 'BAT-1', passportIdHash: H('d'), contractAddress: H('f') });
        assert.deepEqual(sent[0].tx.calls.map((c) => c.circuit), ['attest', 'bindDocument']);
        await assert.rejects(
            anchorPassport(lane, { payloadHash: H('a'), passportId: 'BAT-1', passportIdHash: H('d'), contractAddress: H('f'), contentRoot: H('c') }),
            /schemaId is required/);
    });
});

describe('ProofCartError', () => {
    it('carries whether the transaction may have landed, and the job', () => {
        const e = new ProofCartError('proof cart: PARTIAL_SUCCESS', { partial: true, jobId: 'job-1', cause: new Error('x') });
        assert.equal(e.name, 'ProofCartError');
        assert.equal(e.partial, true);
        assert.equal(e.jobId, 'job-1');
        assert.equal(new ProofCartError('m', { partial: false }).jobId, '');
    });
});
