/**
 * Worker-thread host of one RemoteLane. Spawned by RemoteLaneWorker with the
 * lane's config, seed and label in workerData; answers {id, method, args}
 * messages with {id, ok, result} or {id, ok:false, error}. Never imported by
 * the main thread.
 */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { RemoteLane, serializeLaneError, REMOTE_LANE_WORKER_METHODS } from './lane-remote';

const port = parentPort;
if (!port) throw new Error('lane-remote-worker: must run as a worker thread');

const { cfg, seedHex, label } = workerData as { cfg: any; seedHex: string; label: string };
const lane = new RemoteLane(cfg, seedHex, label);

port.on('message', async (m: { id: number; method: string; args: unknown[] }) => {
    try {
        if (m.method === 'ping') {
            port.postMessage({ id: m.id, ok: true, result: { threadId, label } });
            return;
        }
        if (!REMOTE_LANE_WORKER_METHODS.has(m.method)) throw new Error(`lane-remote-worker: unknown method '${m.method}'`);
        const result = await (lane as any)[m.method](...(m.args ?? []));
        port.postMessage({ id: m.id, ok: true, result });
    } catch (e) {
        port.postMessage({ id: m.id, ok: false, error: serializeLaneError(e) });
    }
});
