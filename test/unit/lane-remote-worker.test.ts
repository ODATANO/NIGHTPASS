import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { threadId } from 'node:worker_threads';
import {
    serializeLaneError, deserializeLaneError, createRemoteLane, RemoteLaneWorker, RemoteLane, remoteIdentity,
    REMOTE_LANE_WORKER_METHODS, type RemoteLaneConfig
} from '../../srv/lib/lane-remote';
import { ProofCartError } from '../../srv/lib/chain-lane';

// The worker host of the remote lane: errors survive the thread boundary with
// their settlement-relevant fields, and the proxy spawns, answers and releases
// a real worker thread. Chain calls stay live-proven.

const CFG: RemoteLaneConfig = {
    apiUrl: 'https://api.example', agentToken: 'ngat_x', networkId: 'preprod',
    indexerHttpUrl: 'https://indexer.example/api/v4/graphql', indexerWsUrl: 'wss://indexer.example/api/v4/graphql/ws',
    nodeUrl: 'wss://rpc.example'
};
const SEED = 'ab'.repeat(64);

describe('lane error serialization', () => {
    it('keeps a ProofCartError partial, its job id and claim ids', () => {
        const e = new ProofCartError('proof cart: PARTIAL_SUCCESS', {
            partial: true, jobId: 'job-1', claimIds: new Map([['k1', 'pa-1']]), cause: { job: { errorCode: 'OnChainStatus' } }
        });
        const back = deserializeLaneError(serializeLaneError(e));
        assert.ok(back instanceof ProofCartError);
        assert.equal(back.partial, true);
        assert.equal(back.jobId, 'job-1');
        assert.deepEqual([...back.claimIds.entries()], [['k1', 'pa-1']]);
        assert.equal(back.message, 'proof cart: PARTIAL_SUCCESS');
        assert.equal((back as any).code, 'OnChainStatus');
    });

    it('keeps status and code of a plain error, and never throws on a non-error', () => {
        const e = Object.assign(new Error('busy'), { status: 503, code: 'JOB_ADMISSION_BUSY' });
        const back = deserializeLaneError(serializeLaneError(e)) as any;
        assert.equal(back.message, 'busy');
        assert.equal(back.status, 503);
        assert.equal(back.code, 'JOB_ADMISSION_BUSY');
        assert.ok(!(back instanceof ProofCartError));
        const s = serializeLaneError('boom');
        assert.equal(s.message, 'boom');
        assert.equal(deserializeLaneError(s).message, 'boom');
    });
});

describe('createRemoteLane', () => {
    it('gives a worker proxy by default and the in-process lane when inline is requested', () => {
        assert.ok(createRemoteLane(CFG, SEED, 'x', {}) instanceof RemoteLaneWorker);
        assert.ok(createRemoteLane(CFG, SEED, 'x', { NIGHTPASS_REMOTE_LANE_INLINE: '1' }) instanceof RemoteLane);
        assert.ok(createRemoteLane(CFG, SEED, 'x', { NIGHTPASS_REMOTE_LANE_INLINE: 'off' }) instanceof RemoteLaneWorker);
    });

    it('forwards exactly the lane surface', () => {
        for (const m of ['identity', 'submitAnchorTx', 'submitProofCart', 'verifyClaimLanded', 'verifyAnchor', 'dispose']) {
            assert.ok(REMOTE_LANE_WORKER_METHODS.has(m), m);
            assert.equal(typeof (RemoteLane.prototype as any)[m], 'function', m);
            assert.equal(typeof (RemoteLaneWorker.prototype as any)[m], 'function', m);
        }
    });
});

describe('RemoteLaneWorker', () => {
    it('answers from a separate thread, rejects unknown methods, and releases the thread on dispose', async () => {
        const lane = new RemoteLaneWorker(CFG, SEED, 'unit');
        const pong = await lane.ping();
        assert.notEqual(pong.threadId, threadId);
        assert.equal(pong.label, 'unit');
        await assert.rejects((lane as any).call('nope'), /unknown method 'nope'/);
        await lane.dispose();
        await lane.dispose();
        assert.equal((lane as any).worker, null);
    });
});

describe('remoteIdentity', () => {
    it('derives a deterministic attester id and a preprod NIGHT address without a builder', async () => {
        const a = await remoteIdentity(CFG, SEED);
        const b = await remoteIdentity(CFG, SEED);
        assert.match(a.attesterId, /^[0-9a-f]{64}$/);
        assert.equal(a.attesterId, b.attesterId);
        assert.match(a.nightAddress, /^mn_addr_preprod1/);
        assert.equal(a.provingMode, 'wasm');
        assert.equal((await remoteIdentity({ ...CFG, proofServerUrl: 'http://p:6300' }, SEED)).provingMode, 'server');
        assert.notEqual((await remoteIdentity(CFG, 'cd'.repeat(64))).attesterId, a.attesterId);
    });
});
