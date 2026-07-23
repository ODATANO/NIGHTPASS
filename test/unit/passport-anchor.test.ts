import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    sortKeys, canonicalize, blake2b256Hex, hashPayload,
    scaleValue, fieldKeyHex, VALUE_SCALE, encryptPayload, waitForJobResult
} from '../../srv/lib/passport-anchor';

describe('canonicalize + hashPayload', () => {
    it('sorts object keys recursively and deterministically', () => {
        const a = { b: 1, a: { z: [3, { y: 2, x: 1 }], k: 'v' } };
        const b = { a: { k: 'v', z: [3, { x: 1, y: 2 }] }, b: 1 };
        assert.equal(canonicalize(a), canonicalize(b));
        assert.deepEqual(sortKeys([{ b: 1, a: 2 }]), [{ a: 2, b: 1 }]);
    });

    it('preserves array order (arrays are significant, not sorted)', () => {
        assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }));
    });

    it('hashPayload is a stable 64-hex over the canonical form', () => {
        const h1 = hashPayload({ b: 1, a: 2 }).payloadHash;
        const h2 = hashPayload({ a: 2, b: 1 }).payloadHash;
        assert.equal(h1, h2);
        assert.match(h1, /^[0-9a-f]{64}$/);
    });
});

describe('blake2b256Hex', () => {
    it('matches the blake2b-256 empty-string vector', () => {
        assert.equal(
            blake2b256Hex(''),
            '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8'
        );
    });
});

describe('scaleValue + fieldKeyHex', () => {
    it('scales to integer milli-units', () => {
        assert.equal(scaleValue(3.412), Math.round(3.412 * VALUE_SCALE));
        assert.equal(scaleValue('16.5'), 16500);
    });

    it('fieldKeyHex is the blake2b-256 of the field name', () => {
        assert.equal(fieldKeyHex('carbonFootprintKgCO2'), blake2b256Hex('carbonFootprintKgCO2'));
        assert.match(fieldKeyHex('capacityKwh'), /^[0-9a-f]{64}$/);
    });
});

describe('encryptPayload', () => {
    it('lays out iv(12) || tag(16) || ciphertext and is nonce-randomized', () => {
        const pt = 'hello passport';
        const a = encryptPayload(pt, 'BAT-PREVIEW-0001');
        const b = encryptPayload(pt, 'BAT-PREVIEW-0001');
        assert.equal(a.length, 12 + 16 + Buffer.byteLength(pt, 'utf8'));
        assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12)); // random iv per call
    });
});

describe('waitForJobResult', () => {
    it('stops immediately when NIGHTGATE requires reconciliation', async () => {
        const nightgate = {
            send: async () => ({
                status: 'reconciliation_required',
                submissionId: 'sub-1',
                txHash: '0xabc',
                errorCode: 'PROCESS_RESTART_RECONCILE',
                errorMessage: 'verify chain state'
            })
        };

        await assert.rejects(
            waitForJobResult(nightgate as any, 'job-1', 'session-1'),
            /requires reconciliation \(0xabc\).*PROCESS_RESTART_RECONCILE/
        );
    });

    // Chain-outcome enforcement applies whenever NIGHTGATE can advance chainStatus:
    // the crawler, or the crawler-free confirmer (>= 0.9.2, on by default when the
    // crawler is off). It is skipped only when neither runs.
    const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
        const prev: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
        try { await fn(); }
        finally {
            for (const k of Object.keys(vars)) {
                if (prev[k] === undefined) delete process.env[k];
                else process.env[k] = prev[k];
            }
        }
    };

    it('does not treat workflow success as canonical chain success (crawler on)', async () => {
        await withEnv({ NIGHTGATE_CRAWLER_ENABLED: 'true' }, async () => {
            let polls = 0;
            const nightgate = {
                send: async () => {
                    polls++;
                    return polls === 1
                        ? { status: 'succeeded', chainStatus: 'pending', result: '{"txHash":"0xabc"}' }
                        : { status: 'succeeded', chainStatus: 'success', result: '{"txHash":"0xabc"}' };
                }
            };

            const result = await waitForJobResult(
                nightgate as any, 'job-1', 'session-1', undefined,
                { requireChainSuccess: true, pollIntervalMs: 0 }
            );
            assert.equal(result.txHash, '0xabc');
            assert.equal(polls, 2);
        });
    });

    it('rejects a canonically failed chain execution (crawler on)', async () => {
        await withEnv({ NIGHTGATE_CRAWLER_ENABLED: 'true' }, async () => {
            const nightgate = {
                send: async () => ({
                    status: 'succeeded', chainStatus: 'failure', txHash: '0xdead', result: '{"txHash":"0xdead"}'
                })
            };

            await assert.rejects(
                waitForJobResult(
                    nightgate as any, 'job-1', 'session-1', undefined, { requireChainSuccess: true }
                ),
                /chain execution failed \(0xdead\): CHAIN_EXECUTION_FAILED/
            );
        });
    });

    it('enforces chainStatus crawler-free when the confirmer is available (crawler off, default)', async () => {
        // Crawler off but the 0.9.2 crawler-free confirmer advances chainStatus, so
        // the job must still wait for it rather than accepting pending.
        await withEnv({ NIGHTGATE_CRAWLER_ENABLED: 'false', NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM: 'true' }, async () => {
            let polls = 0;
            const nightgate = {
                send: async () => {
                    polls++;
                    return polls === 1
                        ? { status: 'succeeded', chainStatus: 'pending', result: '{"txHash":"0xabc"}' }
                        : { status: 'succeeded', chainStatus: 'success', result: '{"txHash":"0xabc"}' };
                }
            };

            const result = await waitForJobResult(
                nightgate as any, 'job-1', 'session-1', undefined,
                { requireChainSuccess: true, pollIntervalMs: 0 }
            );
            assert.equal(result.txHash, '0xabc');
            assert.equal(polls, 2);
        });
    });

    it('accepts workflow success when neither crawler nor confirmer runs', async () => {
        // Crawler off AND confirmer opted out: chainStatus can never advance, so the
        // job must resolve on server-side workflow success alone (verifyAttestationState
        // provides the crawler-free effect check afterwards).
        await withEnv({ NIGHTGATE_CRAWLER_ENABLED: 'false', NIGHTGATE_CRAWLERLESS_CHAIN_CONFIRM: 'false' }, async () => {
            let polls = 0;
            const nightgate = {
                send: async () => {
                    polls++;
                    return { status: 'succeeded', chainStatus: 'pending', result: '{"txHash":"0xabc"}' };
                }
            };

            const result = await waitForJobResult(
                nightgate as any, 'job-1', 'session-1', undefined,
                { requireChainSuccess: true, pollIntervalMs: 0 }
            );
            assert.equal(result.txHash, '0xabc');
            assert.equal(polls, 1);
        });
    });
});
