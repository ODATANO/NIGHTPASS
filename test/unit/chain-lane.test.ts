import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginLane } from '../../srv/lib/lane-plugin';
import { claimIdsByKey, ProofCartError, type ChainLane } from '../../srv/lib/chain-lane';
import { anchorPassport, CONTRACT_REF } from '../../srv/lib/passport-anchor';
import { anchorTxPlan } from '../../srv/lib/anchor-plan';
import { responseClaimKey } from '../../srv/lib/proof-plan';

// The plugin lane is the moved body of the pre-lane anchor and proof-cart
// runners. These pins hold the NIGHTGATE wire shape fixed: action names,
// argument keys, JSON encodings and the sponsor passthrough.

const H = (c: string) => c.repeat(64);
type Sent = { event: string; data: Record<string, any>; user?: unknown };

function fakeNightgate(o: {
    jobResult?: unknown;
    jobStatus?: Record<string, unknown>;
    immediate?: Record<string, unknown>;
    verify?: Record<string, unknown>;
} = {}) {
    const sent: Sent[] = [];
    const svc: any = {
        async send(req: Sent) {
            sent.push(req);
            if (req.event === 'getJobStatus') {
                return o.jobStatus ?? {
                    status: 'succeeded', chainStatus: 'success',
                    result: JSON.stringify(o.jobResult ?? { txHash: 'tx-' + req.data.jobId })
                };
            }
            if (req.event === 'verifyPredicateAttestation') return o.verify ?? { verified: true, provenTxHash: 'tx-v' };
            return { jobId: 'job-' + req.event, ...(o.immediate ?? {}) };
        }
    };
    return { svc, sent };
}

describe('PluginLane.submitAnchorTx', () => {
    it('sends a single call as submitContractCall with JSON args and the sponsor', async () => {
        const { svc, sent } = fakeNightgate();
        const lane = new PluginLane(svc, 'sess-1', { id: 'u' }, 'sponsor-1');
        const [attest] = anchorTxPlan({ payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c') });
        const out = await lane.submitAnchorTx({ contractAddress: H('f'), tx: attest });
        assert.deepEqual(out, { txHash: 'tx-job-submitContractCall', jobId: 'job-submitContractCall' });
        const call = sent.find((s) => s.event === 'submitContractCall')!;
        assert.deepEqual(call.data, {
            contractAddress: H('f'), circuit: 'attest', compiledArtifactRef: CONTRACT_REF,
            sessionId: 'sess-1', args: JSON.stringify([H('a'), H('b')]), sponsorSessionId: 'sponsor-1'
        });
        assert.deepEqual(call.user, { id: 'u' });
        assert.deepEqual(sent.find((s) => s.event === 'getJobStatus')!.data, { jobId: 'job-submitContractCall', sessionId: 'sess-1' });
    });

    it('sends a multi-call tx as submitContractCallBatch, calls JSON in plan order, no sponsor key when unsponsored', async () => {
        const { svc, sent } = fakeNightgate();
        const lane = new PluginLane(svc, 'sess-1');
        const [, rest] = anchorTxPlan({ payloadHash: H('a'), metadataHash: H('b'), passportIdHash: H('c'), contentRoot: H('d'), schemaId: H('e') });
        await lane.submitAnchorTx({ contractAddress: H('f'), tx: rest });
        const call = sent.find((s) => s.event === 'submitContractCallBatch')!;
        assert.deepEqual(call.data, {
            contractAddress: H('f'), compiledArtifactRef: CONTRACT_REF, sessionId: 'sess-1',
            calls: JSON.stringify([
                { circuit: 'anchorContentRoot', args: [H('a'), H('d'), H('e')] },
                { circuit: 'bindPassport', args: [H('c'), H('a')] }
            ])
        });
        assert.equal('sponsorSessionId' in call.data, false);
    });
});

describe('anchorPassport over a lane', () => {
    it('submits attest alone, then the batch, and reports one step per call with the shared tx', async () => {
        const submitted: string[] = [];
        const lane: ChainLane = {
            kind: 'plugin',
            async submitAnchorTx({ tx }) { submitted.push(tx.label); return { txHash: 'tx-' + tx.label, jobId: 'job-' + tx.label }; },
            async submitProofCart() { throw new Error('not used'); },
            async verifyClaimLanded() { return { verified: false, txHash: '' }; },
            async dispose() {}
        };
        const steps: any[] = [];
        const out = await anchorPassport(lane, {
            payloadHash: H('a'), passportId: 'BAT-1', passportIdHash: H('c'), contractAddress: H('f'),
            contentRoot: H('d'), schemaId: H('e'), onStep: (s) => { steps.push(s); }
        });
        assert.deepEqual(submitted, ['attest', 'anchorContentRoot+bindPassport']);
        assert.equal(out.attestationTxHash, 'tx-attest');
        assert.deepEqual(steps, [
            { kind: 'attest', jobId: 'job-attest', txHash: 'tx-attest' },
            { kind: 'anchorContentRoot', jobId: 'job-anchorContentRoot+bindPassport', txHash: 'tx-anchorContentRoot+bindPassport' },
            { kind: 'bindPassport', jobId: 'job-anchorContentRoot+bindPassport', txHash: 'tx-anchorContentRoot+bindPassport' }
        ]);
    });

    it('refuses a content root without its schema id', async () => {
        const lane = { kind: 'plugin' } as unknown as ChainLane;
        await assert.rejects(
            anchorPassport(lane, { payloadHash: H('a'), passportId: 'x', passportIdHash: H('c'), contractAddress: H('f'), contentRoot: H('d') }),
            /schemaId is required/
        );
    });
});

const CLAIMS = [
    { fieldKey: H('1'), value: '75000', salt: H('2'), siblings: [H('3')], dirs: [true], predicate: 'lessOrEqual' as const, threshold: 4000000, unit: 'kg' },
    { fieldKey: H('4'), value: 'Li-ion NMC', allowedValues: ['Li-ion NMC'], salt: H('5'), siblings: [H('6')], dirs: [false], predicate: 'setMembership' as const }
];
const KEY_P = responseClaimKey({ fieldKey: H('1'), predicate: 'lessOrEqual', threshold: 4000000 })!;
const KEY_M = responseClaimKey({ fieldKey: H('4'), predicate: 'setMembership', setRoot: H('9') })!;

describe('PluginLane.submitProofCart', () => {
    it('sends issueFieldPredicateAttestationBatch with claimsJson verbatim and the in-batch root', async () => {
        const { svc, sent } = fakeNightgate({
            immediate: { claims: JSON.stringify([{ fieldKey: H('1'), predicate: 'lessOrEqual', threshold: 4000000, predicateAttestationId: 'pa-1' }]) },
            jobResult: { proof: { proofValue: 'tx-cart' }, claims: [{ fieldKey: H('4'), claim: { predicate: 'setMembership', setRoot: H('9') }, predicateAttestationId: 'pa-2' }] }
        });
        const lane = new PluginLane(svc, 'sess-1', undefined, 'sponsor-1');
        const out = await lane.submitProofCart({
            contractAddress: H('f'), payloadHash: H('a'), contentRoot: H('d'), schemaId: H('e'), claims: CLAIMS, timeoutMs: 60_000
        });
        const call = sent.find((s) => s.event === 'issueFieldPredicateAttestationBatch')!;
        assert.deepEqual(call.data, {
            payloadHash: H('a'), contentRoot: H('d'), schemaId: H('e'),
            claimsJson: JSON.stringify(CLAIMS),
            sessionId: 'sess-1', contractAddress: H('f'), compiledArtifactRef: CONTRACT_REF, sponsorSessionId: 'sponsor-1'
        });
        assert.equal(out.txHash, 'tx-cart');
        assert.equal(out.jobId, 'job-issueFieldPredicateAttestationBatch');
        assert.equal(out.claimIds.get(KEY_P), 'pa-1');
        assert.equal(out.claimIds.get(KEY_M), 'pa-2');
    });

    it('omits the root keys when the root is already anchored', async () => {
        const { svc, sent } = fakeNightgate({ jobResult: { txHash: 'tx-x' } });
        const lane = new PluginLane(svc, 'sess-1');
        await lane.submitProofCart({ contractAddress: H('f'), payloadHash: H('a'), claims: CLAIMS, timeoutMs: 60_000 });
        const call = sent.find((s) => s.event === 'issueFieldPredicateAttestationBatch')!;
        assert.equal('contentRoot' in call.data, false);
        assert.equal('schemaId' in call.data, false);
    });

    it('classifies a post-submit PARTIAL job as partial and keeps the ids it already knows', async () => {
        const { svc } = fakeNightgate({
            immediate: { claims: JSON.stringify([{ fieldKey: H('1'), predicate: 'lessOrEqual', threshold: 4000000, predicateAttestationId: 'pa-1' }]) },
            jobStatus: { status: 'failed', errorCode: 'OnChainStatus', errorMessage: 'PARTIAL_SUCCESS' }
        });
        const lane = new PluginLane(svc, 'sess-1');
        await assert.rejects(
            lane.submitProofCart({ contractAddress: H('f'), payloadHash: H('a'), claims: CLAIMS, timeoutMs: 60_000 }),
            (e: unknown) => e instanceof ProofCartError && e.partial === true
                && e.jobId === 'job-issueFieldPredicateAttestationBatch' && e.claimIds.get(KEY_P) === 'pa-1'
        );
    });

    it('classifies a pre-submit failure as not partial', async () => {
        const { svc } = fakeNightgate({ jobStatus: { status: 'failed', errorCode: 'Error', errorMessage: 'predicate does not hold' } });
        const lane = new PluginLane(svc, 'sess-1');
        await assert.rejects(
            lane.submitProofCart({ contractAddress: H('f'), payloadHash: H('a'), claims: CLAIMS, timeoutMs: 60_000 }),
            (e: unknown) => e instanceof ProofCartError && e.partial === false && /predicate does not hold/.test(e.message)
        );
    });
});

describe('PluginLane.verifyClaimLanded', () => {
    it('asks verifyPredicateAttestation by id, and answers false without an id (no send)', async () => {
        const { svc, sent } = fakeNightgate({ verify: { verified: true, provenTxHash: 'tx-land' } });
        const lane = new PluginLane(svc, 'sess-1');
        const base = { key: KEY_P, contractAddress: H('f'), payloadHash: H('a'), fieldKey: H('1'), predicate: 'lessOrEqual' as const, threshold: 4000000 };
        assert.deepEqual(await lane.verifyClaimLanded(base), { verified: false, txHash: '' });
        assert.equal(sent.length, 0);
        assert.deepEqual(await lane.verifyClaimLanded({ ...base, predicateAttestationId: 'pa-1' }), { verified: true, txHash: 'tx-land' });
        assert.deepEqual(sent[0].data, { predicateAttestationId: 'pa-1' });
    });
});

describe('chain-lane helpers', () => {
    it('claimIdsByKey merges a JSON-string source and an array source', () => {
        const m = claimIdsByKey(
            JSON.stringify([{ fieldKey: H('1'), predicate: 'lessOrEqual', threshold: 4000000, predicateAttestationId: 'pa-1' }, { fieldKey: H('7') }]),
            [{ fieldKey: H('4'), claim: { predicate: 'setMembership', setRoot: H('9') }, predicateAttestationId: 'pa-2' }],
            'not json', undefined
        );
        assert.equal(m.size, 2);
        assert.equal(m.get(KEY_P), 'pa-1');
        assert.equal(m.get(KEY_M), 'pa-2');
    });
});
