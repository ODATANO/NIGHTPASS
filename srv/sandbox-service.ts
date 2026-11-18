import cds from '@sap/cds';
import { randomBytes, createHash } from 'node:crypto';
import { Testers } from '#cds-models/demo';
import { Runs } from '#cds-models/sandbox';
import { encryptSecret, decryptSecret } from './lib/demo-crypto';
import { detachedFromRequest, explorerTxUrl, effectiveNetwork } from './lib/passport-anchor';
import {
    apiClient, chainLaneConfigured, remoteIdentity, remoteLaneConfigFromEnv, remoteLaneFor, registerRemoteSigner, releaseRemoteSigner,
    type RemoteChainLane
} from './lib/lane-remote';
import type { ComparisonOpening, ComparisonSchemaSlot } from './lib/chain-lane';

const { INSERT, SELECT, UPDATE } = cds.ql;

type ClaimSpec =
    | { kind: 'equality'; doc: 'A' | 'B'; fieldKey: string; expectedValue: string; fieldSalt: string; siblings: string[]; dirs: boolean[]; expectedDigest: string }
    | { kind: 'predicate'; doc: 'A' | 'B'; fieldKey: string; value: string; fieldSalt: string; op: 'greaterOrEqual' | 'lessOrEqual'; threshold: number; siblings: string[]; dirs: boolean[] }
    | { kind: 'documentDiff'; k: number; schema: ComparisonSchemaSlot[]; openingA: ComparisonOpening; openingB: ComparisonOpening }
    | { kind: 'documentIntegrity'; allowedMask: number; schema: ComparisonSchemaSlot[]; openingA: ComparisonOpening; openingB: ComparisonOpening };

interface DocCoords { payloadHash: string; storageRef?: string; metadata?: string; contentRoot: string; schemaId: string }
interface RunSpec { documents: { A: DocCoords; B?: DocCoords }; claims: ClaimSpec[] }
interface RunCtx { runId: string; testerRowId: string; testerId: string; label: string; spec: RunSpec }

/**
 * SandboxService: sponsored anchor + proof runs for outside NIGHTGATE testers.
 * Mirrors DemoService's safety machinery (cap lock, detached writes,
 * single-flight queue), but the run body works on the raw vault calls
 * against ONE shared vault instead of the battery passport flow.
 *
 * The tester's client does the compute-only prep (prepareDocumentProof) and
 * sends coordinates; this service builds and signs the transactions with the
 * tester's seed, and the NIGHTGATE API's pool pays the fees.
 */
export default class SandboxService extends cds.ApplicationService {
    private queue: string[] = [];
    private running = new Set<string>();
    private pending = new Map<string, RunCtx>();

    override async init(): Promise<void> {
        this.on('startTester', this.startTester);
        this.on('prepareProof', this.prepareProof);
        this.on('runSandbox', this.runSandbox);
        this.on('sandboxRunStatus', this.sandboxRunStatus);
        this.on('sandboxInfo', this.sandboxInfo);
        cds.on('served', () => {
            if (process.env.DEMO_ENABLED === 'true' && process.env.SANDBOX_CONTRACT_ADDRESS) {
                const log = cds.log('sandbox');
                if (!this.encryptionKeyOk()) {
                    log.error('DEMO_ENABLED is set but ENCRYPTION_KEY is missing or not 64 hex chars; sandbox stays DISABLED');
                }
                if (!chainLaneConfigured()) {
                    log.error('NIGHTGATE_API_URL or NIGHTGATE_AGENT_TOKEN is missing; sandbox stays DISABLED');
                }
                if (!this.contractAddress()) {
                    log.error('SANDBOX_CONTRACT_ADDRESS is not a vault address (64 hex); sandbox stays DISABLED');
                }
            }
            void this.failStaleRuns().catch(() => { /* best-effort */ });
        });
        await super.init();
    }

    // --- config / helpers -----------------------------------------------------

    private encryptionKeyOk(): boolean { return /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY ?? ''); }
    private contractAddress(): string | null {
        const v = String(process.env.SANDBOX_CONTRACT_ADDRESS ?? '').trim().toLowerCase();
        return /^[0-9a-f]{64}$/.test(v) ? v : null;
    }
    private enabled(): boolean {
        return process.env.DEMO_ENABLED === 'true' && this.encryptionKeyOk() && !!this.contractAddress() && chainLaneConfigured();
    }
    private queueDepth(): number { return this.queue.length + this.running.size; }
    private maxPerDay(): number { return Number(process.env.SANDBOX_MAX_PER_DAY || 50); }
    private maxPerIpPerDay(): number { return Number(process.env.SANDBOX_MAX_PER_IP_PER_DAY || 5); }
    private maxPerTester(): number { return Number(process.env.SANDBOX_MAX_PER_TESTER || 3); }
    private maxQueue(): number { return Number(process.env.SANDBOX_MAX_QUEUE || 5); }
    private concurrency(): number {
        return Math.max(1, Number(process.env.SANDBOX_CONCURRENCY) || 1);
    }
    private techUser(): any { return new (cds.User as any)({ id: 'producer', roles: ['producer'] }); }
    private clientKeyOf(req: cds.Request): string {
        const ip = String((req as any)?._?.req?.ip ?? 'local');
        return createHash('sha256').update(ip).digest('hex').slice(0, 32);
    }
    private ipExemptFromCap(req: cds.Request): boolean {
        const list = String(process.env.DEMO_IP_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean);
        return list.length ? list.includes(String((req as any)?._?.req?.ip ?? '')) : false;
    }
    private todayIso(): string { return new Date().toISOString().slice(0, 10); }
    private async countToday(entity: any, where: Record<string, unknown> = {}): Promise<number> {
        const row: any = await SELECT.one.from(entity).columns('count(*) as n')
            .where({ ...where, createdAt: { '>=': `${this.todayIso()}T00:00:00Z` } } as any);
        return Number(row?.n ?? 0);
    }

    private capLock: Promise<unknown> = Promise.resolve();
    private withCapLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.capLock.then(fn, fn);
        this.capLock = run.catch(() => { /* keep the chain alive */ });
        return run;
    }
    private async detachedWrite<T>(fn: () => Promise<T>): Promise<T> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
            try { return await (cds as any).tx({}, fn); }
            catch (e) { lastErr = e; if (!/database is locked|SQLITE_BUSY/i.test(String((e as Error)?.message ?? e))) break; }
        }
        throw lastErr;
    }
    private patchRun(runId: string, patch: Record<string, unknown>): Promise<unknown> {
        return this.detachedWrite(() => UPDATE.entity(Runs).set(patch).where({ ID: runId }) as any);
    }
    private async failStaleRuns(): Promise<void> {
        await this.detachedWrite(() =>
            UPDATE.entity(Runs).set({ state: 'failed', error: 'process restarted mid-run' })
                .where({ state: { in: ['queued', 'running'] } }) as any);
    }

    // --- actions --------------------------------------------------------------

    private startTester = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'sandbox is not enabled on this instance');
        const clientKey = this.clientKeyOf(req);
        const ipExempt = this.ipExemptFromCap(req);
        if (!ipExempt && await this.countToday(Testers, { clientKey }) >= this.maxPerIpPerDay()) {
            return req.reject(429, 'daily sandbox budget for this address is used up, try again tomorrow');
        }
        // Bring-your-own identity: with a seed, the caller's OWN attester id
        // signs every attestation (we only sponsor the dust). Without one, mint
        // a throwaway for an anonymous try.
        const supplied = String((req.data as any).seedHex ?? '').trim().toLowerCase();
        const ownIdentity = supplied.length > 0;
        if (ownIdentity && !/^[0-9a-f]{128}$/.test(supplied)) {
            return req.reject(400, 'seedHex must be 128 hex chars (64 bytes); omit it to get a throwaway identity');
        }
        const seedHex = ownIdentity ? supplied : randomBytes(64).toString('hex');
        const info = await remoteIdentity(remoteLaneConfigFromEnv(), seedHex);
        const testerId = cds.utils.uuid();
        await this.withCapLock(async () => {
            if (!ipExempt && await this.countToday(Testers, { clientKey }) >= this.maxPerIpPerDay()) {
                return req.reject(429, 'daily sandbox budget for this address is used up, try again tomorrow');
            }
            await this.detachedWrite(async () => INSERT.into(Testers).entries({
                testerId,
                nickname: String((req.data as any).nickname ?? '').slice(0, 24),
                encSeedHex: encryptSecret(seedHex, testerId),
                shieldedAddress: info.attesterId,
                nightAddress: info.nightAddress,
                clientKey,
                passportCount: 0
            } as any));
        });
        return {
            testerId, attesterId: info.attesterId,
            shieldedAddress: info.attesterId, nightAddress: info.nightAddress,
            ownIdentity
        };
    };

    private prepareProof = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'sandbox is not enabled on this instance');
        const d = req.data as Record<string, unknown>;
        if (!d.documentJson || !d.proofFieldsJson) return req.reject(400, 'documentJson and proofFieldsJson are required');
        let document: unknown, proofFields: unknown;
        try {
            document = JSON.parse(String(d.documentJson));
            proofFields = JSON.parse(String(d.proofFieldsJson));
        } catch { return req.reject(400, 'documentJson and proofFieldsJson must be valid JSON'); }
        // Compute-only on the NIGHTGATE API: no signer, no sponsor, no dust.
        const ng = await apiClient();
        const out: any = await ng.prepareDocumentProof({
            document,
            proofFields,
            ...(d.saltSeed ? { saltSeed: String(d.saltSeed) } : {})
        });
        return {
            contentRoot: String(out.contentRoot), schemaId: String(out.schemaId),
            schema: JSON.stringify(out.schema), fields: JSON.stringify(out.fields), opening: JSON.stringify(out.opening)
        };
    };

    private runSandbox = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'sandbox is not enabled on this instance');
        const data = req.data as Record<string, unknown>;
        const tester: any = await SELECT.one.from(Testers).where({ testerId: String(data.testerId ?? '') });
        if (!tester) return req.reject(404, 'unknown testerId (start the sandbox first)');

        let spec: RunSpec;
        try { spec = JSON.parse(String(data.runSpecJson ?? '')); }
        catch { return req.reject(400, 'runSpecJson must be valid JSON'); }
        const specError = this.validateSpec(spec);
        if (specError) return req.reject(400, specError);

        const clientKey = this.clientKeyOf(req);
        const runId = cds.utils.uuid();
        const label = String(data.label ?? '').slice(0, 120);
        const gate = await this.withCapLock(async () => {
            if (this.queueDepth() >= this.maxQueue()) {
                return req.reject(429, 'the sandbox is busy right now, try again in a few minutes');
            }
            if (!this.ipExemptFromCap(req) && await this.countToday(Runs, { clientKey }) >= this.maxPerIpPerDay()) {
                return req.reject(429, 'daily sandbox budget for this address is used up, try again tomorrow');
            }
            if (await this.countToday(Runs) >= this.maxPerDay()) {
                return req.reject(429, 'the sandbox reached its daily on-chain budget, try again tomorrow');
            }
            // Per-tester cap as an atomic conditional increment on Testers.passportCount.
            const won: any = await this.detachedWrite(async () =>
                UPDATE.entity(Testers).set({ passportCount: { '+=': 1 } } as any)
                    .where({ ID: tester.ID, passportCount: { '<': this.maxPerTester() } } as any));
            if (!won) return req.reject(429, `this tester used up its sandbox budget (${this.maxPerTester()} runs)`);
            await this.detachedWrite(async () => INSERT.into(Runs).entries({
                ID: runId, tester_ID: tester.ID, label, state: 'queued',
                stepsJson: JSON.stringify(this.initialSteps(spec)), clientKey
            } as any));
            return true;
        });
        if (gate !== true) return;

        const ctx: RunCtx = { runId, testerRowId: tester.ID, testerId: tester.testerId, label, spec };
        (req as any).on('succeeded', () => { this.queue.push(runId); this.pending.set(runId, ctx); this.processQueue(); });
        return { runId, queuePosition: this.queueDepth() };
    };

    private sandboxRunStatus = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'sandbox is not enabled on this instance');
        const runId = String((req.data as any).runId ?? '');
        const row: any = await SELECT.one.from(Runs).where({ ID: runId });
        if (!row) return req.reject(404, 'unknown runId');
        const ahead = this.queue.indexOf(runId);
        return {
            state: row.state, stepsJson: row.stepsJson ?? '[]', resultJson: row.resultJson ?? null,
            error: row.error ?? null, queuePosition: ahead < 0 ? 0 : ahead + this.running.size
        };
    };

    private sandboxInfo = async (req: cds.Request) => {
        const used = this.enabled() ? await this.countToday(Runs) : 0;
        return {
            enabled: this.enabled(),
            contractAddress: this.contractAddress() ?? '',
            network: effectiveNetwork(),
            queueDepth: this.queue.length, runningCount: this.running.size,
            dailyRemaining: Math.max(0, this.maxPerDay() - used)
        };
    };

    // --- validation + timeline ------------------------------------------------

    private validateSpec(spec: RunSpec): string | null {
        if (!spec || typeof spec !== 'object') return 'runSpecJson must be an object';
        if (!spec.documents?.A?.payloadHash || !spec.documents.A.contentRoot || !spec.documents.A.schemaId) {
            return 'documents.A must carry payloadHash, contentRoot and schemaId';
        }
        if (!Array.isArray(spec.claims) || spec.claims.length === 0) return 'claims must be a non-empty array';
        if (spec.claims.length > 8) return 'at most 8 claims per run';
        for (const c of spec.claims) {
            if (!c || typeof (c as any).kind !== 'string') return 'each claim needs a kind';
            const kind = (c as any).kind;
            if (!['equality', 'predicate', 'documentDiff', 'documentIntegrity'].includes(kind)) {
                return `unsupported claim kind '${kind}' (equality | predicate | documentDiff | documentIntegrity)`;
            }
            if ((kind === 'documentDiff' || kind === 'documentIntegrity') && !spec.documents.B?.payloadHash) {
                return `${kind} needs documents.B`;
            }
        }
        return null;
    }

    private initialSteps(spec: RunSpec): Array<Record<string, unknown>> {
        const steps: Array<Record<string, unknown>> = [{ kind: 'anchor:A', status: 'pending' }];
        if (spec.documents.B) steps.push({ kind: 'anchor:B', status: 'pending' });
        spec.claims.forEach((c, i) => steps.push({ kind: `claim:${i}:${c.kind}`, status: 'pending' }));
        return steps;
    }

    // --- queue + execution ----------------------------------------------------

    private processQueue(): void {
        while (this.queue.length && this.running.size < this.concurrency()) {
            const runId = this.queue.shift()!;
            const ctx = this.pending.get(runId);
            this.pending.delete(runId);
            if (!ctx) continue;
            this.running.add(runId);
            void detachedFromRequest(() => this.executeRun(ctx))
                .catch(async (e: unknown) => {
                    const msg = String((e as Error)?.message ?? e).slice(0, 480);
                    cds.log('sandbox').warn(`run ${runId} failed:`, e);
                    await this.patchRun(runId, { state: 'failed', error: msg }).catch(() => { /* best-effort */ });
                })
                .finally(() => {
                    this.running.delete(runId);
                    this.processQueue();
                });
        }
    }

    private async executeRun(ctx: RunCtx): Promise<void> {
        const log = cds.log('sandbox');
        const { runId, spec } = ctx;
        const contractAddress = this.contractAddress()!;
        const steps = this.initialSteps(spec);
        const result: any = { network: effectiveNetwork(), contractAddress, documents: {}, claims: [] };

        const setStep = async (kind: string, patch: Record<string, unknown>) => {
            const s = steps.find(x => x.kind === kind);
            if (s) Object.assign(s, patch);
            try { await this.patchRun(runId, { stepsJson: JSON.stringify(steps) }); }
            catch (e) { log.warn(`run ${runId}: timeline write failed (continuing):`, (e as Error)?.message); }
        };

        await this.patchRun(runId, { state: 'running' });

        // The tester's seed signs for the length of the run; the API's pool pays the fees.
        const tester: any = await SELECT.one.from(Testers).where({ ID: ctx.testerRowId });
        registerRemoteSigner(runId, decryptSecret(tester.encSeedHex, tester.testerId), { contractAddress });
        let opened: RemoteChainLane | null = null;
        try {
            const lane = opened = remoteLaneFor(runId);
            // The tester's attester id names every record it anchors.
            const attesterId = await lane.attesterId();

            // 1. Anchor document A (and B if present): the hash and its content root in one transaction.
            const anchorDoc = async (label: 'A' | 'B', d: DocCoords) => {
                await setStep(`anchor:${label}`, { status: 'running' });
                const metadataHash = createHash('sha256').update(d.metadata ?? JSON.stringify({ via: 'nightgate-sandbox' })).digest('hex');
                const { txHash } = await lane.submitVaultTx({
                    contractAddress,
                    tx: {
                        label: `anchor:${label}`,
                        calls: [
                            { circuit: 'attest', args: [d.payloadHash, metadataHash] },
                            { circuit: 'anchorContentRoot', args: [d.payloadHash, d.contentRoot, d.schemaId] }
                        ]
                    }
                });
                result.documents[label] = { payloadHash: d.payloadHash, contentRoot: d.contentRoot, anchorTx: txHash };
                await setStep(`anchor:${label}`, { status: 'succeeded', txHash, explorerUrl: explorerTxUrl(txHash) });
            };
            await anchorDoc('A', spec.documents.A);
            if (spec.documents.B) await anchorDoc('B', spec.documents.B);
            result.attesterId = attesterId;

            // 2. Each claim against the shared vault.
            for (let i = 0; i < spec.claims.length; i++) {
                const c = spec.claims[i];
                const stepKind = `claim:${i}:${c.kind}`;
                await setStep(stepKind, { status: 'running' });
                const { tx, verify } = await this.runClaim(lane, contractAddress, attesterId, spec, c);
                result.claims.push({ index: i, kind: c.kind, txHash: tx, verify: { attesterId, ...verify } });
                await setStep(stepKind, { status: 'succeeded', txHash: tx, explorerUrl: explorerTxUrl(tx) });
            }

            await this.patchRun(runId, { state: 'done', resultJson: JSON.stringify(result) });
        } finally {
            await opened?.dispose().catch(() => { /* nothing left to release */ });
            releaseRemoteSigner(runId);
        }
    }

    /** One claim as its own transaction, with the coordinates a verifier needs. */
    private async runClaim(
        lane: RemoteChainLane, contractAddress: string, attesterId: string, spec: RunSpec, c: ClaimSpec
    ): Promise<{ tx: string; verify: Record<string, unknown> }> {
        const A = spec.documents.A, B = spec.documents.B;
        if (c.kind === 'equality' || c.kind === 'predicate') {
            const d = c.doc === 'B' && B ? B : A;
            const path = { fieldKey: c.fieldKey, salt: c.fieldSalt, siblings: c.siblings, dirs: c.dirs };
            const { txHash } = await lane.submitProofCart({
                contractAddress, payloadHash: d.payloadHash,
                claims: [c.kind === 'equality'
                    ? { ...path, expectedDigest: c.expectedDigest, predicate: 'bytesEquality' }
                    : { ...path, value: c.value, predicate: c.op, threshold: c.threshold }]
            });
            return c.kind === 'equality'
                ? { tx: txHash, verify: { payloadHash: d.payloadHash, fieldKey: c.fieldKey, predicate: 'bytesEquality', expectedDigest: c.expectedDigest } }
                : { tx: txHash, verify: { payloadHash: d.payloadHash, fieldKey: c.fieldKey, predicate: c.op, threshold: c.threshold } };
        }
        const { txHash } = await lane.submitComparison({
            contractAddress,
            payloadHashA: A.payloadHash, attesterIdA: attesterId,
            payloadHashB: B!.payloadHash, attesterIdB: attesterId,
            schema: c.schema, openingA: c.openingA, openingB: c.openingB,
            claims: [c.kind === 'documentDiff' ? { kind: 'documentDiff', k: c.k } : { kind: 'documentIntegrity', allowedMask: c.allowedMask }]
        });
        return c.kind === 'documentDiff'
            ? { tx: txHash, verify: { payloadHash: A.payloadHash, payloadHashB: B!.payloadHash, predicate: 'documentDiff', k: c.k } }
            : { tx: txHash, verify: { payloadHash: A.payloadHash, payloadHashB: B!.payloadHash, predicate: 'documentIntegrity', allowedMask: c.allowedMask } };
    }
}
