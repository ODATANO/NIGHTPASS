import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    artifactCacheDir, cacheDirForManifest,
    isRebuildable, remoteLaneConfigFromEnv, resolveTxHash,
    registerRemoteSigner, releaseRemoteSigner, hasRemoteSigner, remoteLaneFor, remoteVaultFor,
    REMOTE_LANE_CIRCUITS
} from '../../srv/lib/lane-remote';

// Network-free pins for the remote lane: configuration, retry classification
// and the in-memory signer registry. The build/sponsor path is proven live.

const ENV = {
    NIGHTGATE_API_URL: 'https://api.example/',
    DEMO_NIGHTGATE_AGENT_TOKEN: 'ngat_x',
    NIGHTGATE_NETWORK: 'preprod'
};

describe('remoteLaneConfigFromEnv', () => {
    it('reads the hosted endpoint, token and network; no indexer or node is needed', () => {
        const cfg = remoteLaneConfigFromEnv(ENV);
        assert.equal(cfg.apiUrl, 'https://api.example');
        assert.equal(cfg.agentToken, 'ngat_x');
        assert.equal(cfg.networkId, 'preprod');
        assert.equal(cfg.proofServerUrl, undefined);
        assert.match(String(cfg.cacheDir), /nightgate-txbuilder[\\/]attestation-vault$/);
        assert.ok(!('indexerHttpUrl' in cfg) && !('nodeUrl' in cfg));
    });

    it('takes a proof server, cache dir and ttl', () => {
        const cfg = remoteLaneConfigFromEnv({
            ...ENV, NIGHTGATE_PROOF_SERVER_URL: 'http://proof-server:6300',
            NIGHTGATE_ZK_CACHE_DIR: '/data/zk-cache', NIGHTGATE_TX_TTL_MINUTES: '20'
        });
        assert.equal(cfg.proofServerUrl, 'http://proof-server:6300');
        assert.equal(cfg.cacheDir, '/data/zk-cache');
        assert.equal(cfg.ttlMinutes, 20);
    });

    it('names the missing key', () => {
        const { DEMO_NIGHTGATE_AGENT_TOKEN: _t, ...rest } = ENV;
        assert.throws(() => remoteLaneConfigFromEnv(rest), /DEMO_NIGHTGATE_AGENT_TOKEN is not set/);
        assert.throws(() => remoteLaneConfigFromEnv({ ...ENV, NIGHTGATE_API_URL: ' ' }), /NIGHTGATE_API_URL is not set/);
    });
});

describe('isRebuildable', () => {
    const cases: Array<[unknown, boolean]> = [
        [Object.assign(new Error('busy'), { status: 503 }), true],
        [Object.assign(new Error('slow down'), { status: 429 }), true],
        [Object.assign(new Error('x'), { code: 'JOB_ADMISSION_BUSY' }), true],
        [{ job: { errorCode: 'WALLET_SYNCING', errorMessage: 'sponsor still syncing' } }, true],
        [new Error('node rejected: 1010/104 state conflict'), true],
        [new Error('ensureZkAssets: GET https://api/zk-config/attestation-vault/zkir/bindDocument.bzkir -> HTTP 502'), true],
        [new Error('ensureZkAssets: GET https://api/zk-config/x -> HTTP 404'), false],
        [new Error('InvalidDustSpendProof (1010/170)'), true],
        [new Error('Custom error 1014'), true],
        [new Error('predicate does not hold'), false],
        [Object.assign(new Error('forbidden'), { status: 403, code: 'SPONSOR_POLICY_EMPTY' }), false],
        [new Error('1010/188 sequencing'), false],
        ['could not deserialize finalized tx', false]
    ];
    for (const [err, want] of cases) {
        it(`${String((err as any)?.message ?? (err as any)?.job?.errorCode ?? err)} -> ${want}`, () => {
            assert.equal(isRebuildable(err), want);
        });
    }
});

describe('remote signer registry', () => {
    const seed = 'ab'.repeat(64);
    const RUN = '0d052525-fcbd-44e0-9ad9-c19d33893819';
    it('registers, resolves and releases a seed under a run-id handle', () => {
        registerRemoteSigner(RUN, seed);
        assert.equal(hasRemoteSigner(RUN), true);
        const lane = remoteLaneFor(RUN, remoteLaneConfigFromEnv(ENV));
        assert.equal(lane.kind, 'remote');
        releaseRemoteSigner(RUN);
        assert.equal(hasRemoteSigner(RUN), false);
        assert.throws(() => remoteLaneFor(RUN, remoteLaneConfigFromEnv(ENV)), /no signer registered/);
    });

    it('carries the leased vault of a run, and none when no vault was pinned', () => {
        const vault = 'C'.repeat(64);
        registerRemoteSigner(RUN, seed, { contractAddress: vault });
        assert.equal(remoteVaultFor(RUN), vault.toLowerCase());
        registerRemoteSigner(RUN, seed);
        assert.equal(remoteVaultFor(RUN), undefined);
        assert.equal(remoteVaultFor(undefined), undefined);
        releaseRemoteSigner(RUN);
        assert.throws(() => registerRemoteSigner(RUN, seed, { contractAddress: 'nope' }), /64 hex/);
    });

    it('a NIGHTGATE session id is never a remote signer; malformed handles and seeds are refused', () => {
        assert.equal(hasRemoteSigner('5b24bb7b-a9db-45a3-aa3a-aabedefa51bb'), false);
        assert.throws(() => registerRemoteSigner('remote:run-1', seed), /must be a UUID/);
        assert.throws(() => registerRemoteSigner(RUN, 'abc'), /128 hex chars/);
    });

    it('pins the demo circuit set', () => {
        assert.deepEqual(REMOTE_LANE_CIRCUITS, ['attest', 'bindDocument', 'anchorContentRoot', 'proveFieldPredicate', 'proveFieldMembership']);
    });
});

describe('resolveTxHash', () => {
    const HASH = 'a'.repeat(64);
    const ID = '00' + 'b'.repeat(64);
    const lookupOk = {
        async transactionByIdentifier(identifier: string) {
            assert.equal(identifier, ID);
            return { hash: '0x' + HASH.toUpperCase() };
        },
    };

    it('passes a 64-hex hash through untouched', async () => {
        let called = 0;
        const lookup = { async transactionByIdentifier() { called++; return null; } };
        assert.equal(await resolveTxHash('0x' + HASH.toUpperCase(), lookup), HASH);
        assert.equal(called, 0);
    });

    it('maps a 66-char identifier to the block hash through the hosted API', async () => {
        assert.equal(await resolveTxHash(ID, lookupOk), HASH);
    });

    it('retries while the server has not indexed the block and finally keeps the identifier', async () => {
        let calls = 0;
        const lookup = { async transactionByIdentifier() { calls++; return null; } };
        assert.equal(await resolveTxHash(ID, lookup, { attempts: 3, delayMs: 1 }), ID);
        assert.equal(calls, 3);
    });
});

describe('prover-key cache keyed by the hosted artifact', () => {
    const HASH = '699b7f9fbfbe09e1bac14030105328e150ed23fa515211a5fc2622302073c90c';
    const manifest = { contracts: [{ name: 'counter', artifactHash: 'f9'.repeat(32) }, { name: 'attestation-vault', artifactHash: HASH }] };

    it('nests the cache under the first 16 hex of the attestation-vault digest', () => {
        assert.match(cacheDirForManifest('/data/zk-cache', manifest), /zk-cache[\\/]699b7f9fbfbe09e1$/);
    });

    it('stays on the base when the manifest names no vault or a malformed digest', () => {
        assert.equal(cacheDirForManifest('/base', { contracts: [{ name: 'counter', artifactHash: 'ab' }] }), '/base');
        assert.equal(cacheDirForManifest('/base', { contracts: [{ name: 'attestation-vault', artifactHash: 'nope' }] }), '/base');
        assert.equal(cacheDirForManifest('/base', null), '/base');
    });

    it('resolves through the hosted manifest, retries, and never falls back to the unkeyed base', async () => {
        const cfg = remoteLaneConfigFromEnv({ ...ENV, NIGHTGATE_API_URL: 'https://keyed.example', NIGHTGATE_ZK_CACHE_DIR: '/zk' });
        const ok = (async () => new Response(JSON.stringify(manifest), { status: 200 })) as unknown as typeof fetch;
        assert.match(await artifactCacheDir(cfg, { fetchFn: ok }), /^[\\/]zk[\\/]699b7f9fbfbe09e1$/);
        // second attempt succeeds: one transient failure is absorbed
        const flaky = remoteLaneConfigFromEnv({ ...ENV, NIGHTGATE_API_URL: 'https://flaky.example', NIGHTGATE_ZK_CACHE_DIR: '/zk' });
        let n = 0;
        const onceDown = (async () => { if (n++ === 0) throw new Error('timeout'); return new Response(JSON.stringify(manifest), { status: 200 }); }) as unknown as typeof fetch;
        assert.match(await artifactCacheDir(flaky, { fetchFn: onceDown, delayMs: 1 }), /699b7f9fbfbe09e1$/);
        assert.equal(n, 2);
        const down = remoteLaneConfigFromEnv({ ...ENV, NIGHTGATE_API_URL: 'https://down.example', NIGHTGATE_ZK_CACHE_DIR: '/zk' });
        const fail = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
        await assert.rejects(artifactCacheDir(down, { fetchFn: fail, attempts: 2, delayMs: 1 }), /manifest unavailable after 2 attempts.*ECONNREFUSED/);
    });
});
