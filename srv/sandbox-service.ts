import cds from '@sap/cds';
import { randomBytes, createHash } from 'node:crypto';
import { Testers } from '#cds-models/demo';
import { Runs } from '#cds-models/sandbox';
import { feeSponsorWalletIds, producerWalletSecrets } from './lib/producer-wallets';
import { encryptSecret, decryptSecret } from './lib/demo-crypto';
import { sendDetached, waitForJobResult, detachedFromRequest, explorerTxUrl, effectiveNetwork } from './lib/passport-anchor';

const { INSERT, SELECT, UPDATE } = cds.ql;

type ClaimSpec =
    | { kind: 'equality'; doc: 'A' | 'B'; fieldKey: string; expectedValue: string; fieldSalt: string; siblings: string[]; dirs: boolean[]; expectedDigest: string }
    | { kind: 'predicate'; doc: 'A' | 'B'; fieldKey: string; value: string; fieldSalt: string; op: 'greaterOrEqual' | 'lessOrEqual'; threshold: number; siblings: string[]; dirs: boolean[] }
    | { kind: 'documentDiff'; k: number; schema: unknown; openingA: unknown; openingB: unknown }
    | { kind: 'documentIntegrity'; allowedMask: number; schema: unknown; openingA: unknown; openingB: unknown };

interface DocCoords { payloadHash: string; storageRef?: string; metadata?: string; contentRoot: string; schemaId: string }
interface RunSpec { documents: { A: DocCoords; B?: DocCoords }; claims: ClaimSpec[] }
interface RunCtx { runId: string; testerRowId: string; testerId: string; label: string; spec: RunSpec }

/**
 * SandboxService: sponsored anchor + proof runs for outside NIGHTGATE testers.
 * Mirrors DemoService's safety machinery (cap lock, detached writes, sponsor
 * pool lease, single-flight queue), but the run body is the raw attestation-
 * vault lane against ONE shared vault instead of the battery passport lane.
 *
 * The tester's client does the compute-only prep (prepareDocumentProof) and
 * sends coordinates; this service only performs the DUST-SPENDING submits,
 * each carrying the leased sponsor's session so the sponsor pays.
 */
export default class SandboxService extends cds.ApplicationService {
    private queue: string[] = [];
    private running = new Set<string>();
    private pending = new Map<string, RunCtx>();
    /** walletId -> runId currently holding it; one run per sponsor at a time. */
    private sponsorLeases = new Map<string, string>();

    override async init(): Promise<void> {
        this.on('startTester', this.startTester);
        this.on('prepareProof', this.prepareProof);
        this.on('runSandbox', this.runSandbox);
        this.on('sandboxRunStatus', this.sandboxRunStatus);
        this.on('sandboxInfo', this.sandboxInfo);
        cds.on('served', () => {
            if (process.env.DEMO_ENABLED === 'true' && !this.encryptionKeyOk()) {
                cds.log('sandbox').error(
                    'DEMO_ENABLED is set but ENCRYPTION_KEY is missing or not 64 hex chars; sandbox stays DISABLED');
            }
            void this.failStaleRuns().catch(() => { /* best-effort */ });
        });
        await super.init();
    }

    // --- config / helpers -----------------------------------------------------

    private encryptionKeyOk(): boolean { return /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY ?? ''); }
    private contractAddress(): string | null { return process.env.SANDBOX_CONTRACT_ADDRESS ?? null; }
    private enabled(): boolean {
        return process.env.DEMO_ENABLED === 'true' && this.encryptionKeyOk() && !!this.contractAddress();
    }
    private queueDepth(): number { return this.queue.length + this.running.size; }
    private maxPerDay(): number { return Number(process.env.SANDBOX_MAX_PER_DAY || 50); }
    private maxPerIpPerDay(): number { return Number(process.env.SANDBOX_MAX_PER_IP_PER_DAY || 5); }
    private maxPerTester(): number { return Number(process.env.SANDBOX_MAX_PER_TESTER || 3); }
    private maxQueue(): number { return Number(process.env.SANDBOX_MAX_QUEUE || 5); }
    private concurrency(): number {
        const pool = feeSponsorWalletIds().length;
        return Math.max(1, Math.min(pool || 1, Number(process.env.SANDBOX_CONCURRENCY || 1)));
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
    private acquireSponsor(runId: string): string | null {
        const free = feeSponsorWalletIds().find((w) => !this.sponsorLeases.has(w));
        if (!free) return null;
        this.sponsorLeases.set(free, runId);
        return free;
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
        const nightgate: any = await cds.connect.to('NightgateService');
        const info: any = await nightgate.tx({ user: this.techUser() }, (tx: any) => tx.send('deriveWalletInfo', { seedHex }));
        const testerId = cds.utils.uuid();
        await this.withCapLock(async () => {
            if (!ipExempt && await this.countToday(Testers, { clientKey }) >= this.maxPerIpPerDay()) {
                return req.reject(429, 'daily sandbox budget for this address is used up, try again tomorrow');
            }
            await this.detachedWrite(async () => INSERT.into(Testers).entries({
                testerId,
                nickname: String((req.data as any).nickname ?? '').slice(0, 24),
                encSeedHex: encryptSecret(seedHex, testerId),
                encViewingKey: encryptSecret(String(info.viewingKey), testerId),
                shieldedAddress: String(info.shieldedAddress),
                nightAddress: String(info.nightAddress),
                clientKey,
                passportCount: 0
            } as any));
        });
        return {
            testerId, attesterId: String(info.attesterId ?? ''),
            shieldedAddress: String(info.shieldedAddress), nightAddress: String(info.nightAddress),
            ownIdentity
        };
    };

    private prepareProof = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'sandbox is not enabled on this instance');
        const d = req.data as Record<string, unknown>;
        if (!d.documentJson || !d.proofFieldsJson) return req.reject(400, 'documentJson and proofFieldsJson are required');
        const nightgate: any = await cds.connect.to('NightgateService');
        // Compute-only: no session, no sponsor, no dust. Runs under the tech
        // principal so a hosted instance need not expose /nightgate publicly.
        const out: any = await nightgate.tx({ user: this.techUser() }, (tx: any) => tx.send('prepareDocumentProof', {
            documentJson: String(d.documentJson),
            proofFieldsJson: String(d.proofFieldsJson),
            ...(d.saltSeed ? { saltSeed: String(d.saltSeed) } : {})
        }));
        return {
            contentRoot: String(out.contentRoot), schemaId: String(out.schemaId),
            schema: String(out.schema), fields: String(out.fields), opening: String(out.opening)
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
            const sponsor = this.acquireSponsor(runId);
            this.running.add(runId);
            void detachedFromRequest(() => this.executeRun(ctx, sponsor ?? undefined))
                .catch(async (e: unknown) => {
                    const msg = String((e as Error)?.message ?? e).slice(0, 480);
                    cds.log('sandbox').warn(`run ${runId} failed:`, e);
                    await this.patchRun(runId, { state: 'failed', error: msg }).catch(() => { /* best-effort */ });
                })
                .finally(() => {
                    this.running.delete(runId);
                    if (sponsor) this.sponsorLeases.delete(sponsor);
                    this.processQueue();
                });
        }
    }

    private async executeRun(ctx: RunCtx, sponsorWalletId?: string): Promise<void> {
        const log = cds.log('sandbox');
        const { runId, spec } = ctx;
        const user = this.techUser();
        const contractAddress = this.contractAddress()!;
        const nightgate: any = await cds.connect.to('NightgateService');
        const producer: any = await cds.connect.to('ProducerService');
        const steps = this.initialSteps(spec);
        const result: any = { network: effectiveNetwork(), contractAddress, documents: {}, claims: [] };

        const setStep = async (kind: string, patch: Record<string, unknown>) => {
            const s = steps.find(x => x.kind === kind);
            if (s) Object.assign(s, patch);
            try { await this.patchRun(runId, { stepsJson: JSON.stringify(steps) }); }
            catch (e) { log.warn(`run ${runId}: timeline write failed (continuing):`, (e as Error)?.message); }
        };

        // A sponsor is required: the tester wallet is zero-funded.
        if (!sponsorWalletId) throw new Error('no fee sponsor available (PASSPORT_FEE_SPONSOR_WALLET); the tester wallet holds no dust');
        const warm: any = await producer.tx({ user }, (tx: any) => tx.send('prewarmServerWallet', { walletId: sponsorWalletId }));
        if (warm?.state === 'error') throw new Error(`fee sponsor '${sponsorWalletId}' unavailable: ${warm?.error || 'no signing session'}`);
        const sess: any = await producer.tx({ user }, (tx: any) => tx.send('serverWalletSession', { walletId: sponsorWalletId }));
        const sponsorSessionId = String(sess.sessionId);

        await this.patchRun(runId, { state: 'running' });

        // Open the tester's zero-funded signing session; SPONSORED_CALLER_SYNC=skip
        // means it needs no chain sync (the sponsor carries the fees).
        const tester: any = await SELECT.one.from(Testers).where({ ID: ctx.testerRowId });
        const seedHex = decryptSecret(tester.encSeedHex, tester.testerId);
        const viewingKey = decryptSecret(tester.encViewingKey, tester.testerId);
        const conn: any = await sendDetached(nightgate, 'connectWallet', { viewingKey }, user);
        const sessionId = String(conn.sessionId);
        const skipCallerSync = process.env.NIGHTGATE_SPONSORED_CALLER_SYNC === 'skip';
        const signing: any = await sendDetached(nightgate, 'connectWalletForSigning',
            { sessionId, seedHex, ...(skipCallerSync ? { prewarm: false } : {}) }, user);
        if (signing?.prewarmJobId && !skipCallerSync) {
            await waitForJobResult(nightgate, String(signing.prewarmJobId), sessionId, user);
        }

        const submit = async (action: string, args: Record<string, unknown>): Promise<string> => {
            const job: any = await sendDetached(nightgate, action, { ...args, sessionId, sponsorSessionId, contractAddress }, user);
            const res: any = await waitForJobResult(nightgate, String(job.jobId), sessionId, user, { requireChainSuccess: true });
            return String(res.txHash ?? res.proof?.proofValue ?? '');
        };

        try {
            // 1. Anchor document A (and B if present): payload_hash = the caller's leaf.
            const anchorDoc = async (label: 'A' | 'B', d: DocCoords) => {
                await setStep(`anchor:${label}`, { status: 'running' });
                const tx = await submit('anchorDocument', {
                    sha256: d.payloadHash, storageRef: d.storageRef ?? `sandbox/${label}`,
                    metadata: d.metadata ?? JSON.stringify({ via: 'nightgate-sandbox' })
                });
                result.documents[label] = { payloadHash: d.payloadHash, contentRoot: d.contentRoot, anchorTx: tx };
                await setStep(`anchor:${label}`, { status: 'succeeded', txHash: tx, explorerUrl: explorerTxUrl(tx) });
            };
            await anchorDoc('A', spec.documents.A);
            if (spec.documents.B) await anchorDoc('B', spec.documents.B);

            // 2. Each claim, sponsored, against the shared vault.
            for (let i = 0; i < spec.claims.length; i++) {
                const c = spec.claims[i];
                const stepKind = `claim:${i}:${c.kind}`;
                await setStep(stepKind, { status: 'running' });
                const { tx, verify } = await this.runClaim(submit, spec, c);
                result.claims.push({ index: i, kind: c.kind, txHash: tx, verify });
                await setStep(stepKind, { status: 'succeeded', txHash: tx, explorerUrl: explorerTxUrl(tx) });
            }

            await this.patchRun(runId, { state: 'done', resultJson: JSON.stringify(result) });
        } finally {
            try { await sendDetached(nightgate, 'disconnectWallet', { sessionId }, user); } catch { /* best-effort */ }
        }
    }

    /** One claim -> the matching sponsored action + the crawler-free verify coordinates. */
    private async runClaim(
        submit: (action: string, args: Record<string, unknown>) => Promise<string>,
        spec: RunSpec, c: ClaimSpec
    ): Promise<{ tx: string; verify: Record<string, unknown> }> {
        const A = spec.documents.A, B = spec.documents.B;
        if (c.kind === 'equality') {
            const d = c.doc === 'B' && B ? B : A;
            const tx = await submit('issueFieldEqualityAttestation', {
                payloadHash: d.payloadHash, fieldKey: c.fieldKey, expectedValue: c.expectedValue,
                fieldSalt: c.fieldSalt, contentRoot: d.contentRoot, schemaId: d.schemaId,
                siblingsJson: JSON.stringify(c.siblings), dirsJson: JSON.stringify(c.dirs)
            });
            return { tx, verify: { payloadHash: d.payloadHash, fieldKey: c.fieldKey, predicate: 'bytesEquality', expectedDigest: c.expectedDigest } };
        }
        if (c.kind === 'predicate') {
            const d = c.doc === 'B' && B ? B : A;
            const tx = await submit('issueFieldPredicateAttestation', {
                payloadHash: d.payloadHash, fieldKey: c.fieldKey, value: c.value, fieldSalt: c.fieldSalt,
                predicate: c.op, threshold: c.threshold, contentRoot: d.contentRoot, schemaId: d.schemaId,
                siblingsJson: JSON.stringify(c.siblings), dirsJson: JSON.stringify(c.dirs)
            });
            return { tx, verify: { payloadHash: d.payloadHash, fieldKey: c.fieldKey, predicate: c.op, threshold: c.threshold } };
        }
        if (c.kind === 'documentDiff') {
            const tx = await submit('issueDocumentDiffAttestation', {
                payloadHashA: A.payloadHash, payloadHashB: B!.payloadHash, k: c.k,
                schemaJson: JSON.stringify(c.schema), openingAJson: JSON.stringify(c.openingA), openingBJson: JSON.stringify(c.openingB),
                contentRootB: B!.contentRoot, schemaId: B!.schemaId
            });
            return { tx, verify: { payloadHash: A.payloadHash, payloadHashB: B!.payloadHash, predicate: 'documentDiff', k: c.k } };
        }
        // documentIntegrity
        const tx = await submit('issueDocumentIntegrityAttestation', {
            payloadHashA: A.payloadHash, payloadHashB: B!.payloadHash, allowedMask: c.allowedMask,
            schemaJson: JSON.stringify(c.schema), openingAJson: JSON.stringify(c.openingA), openingBJson: JSON.stringify(c.openingB),
            contentRootB: B!.contentRoot, schemaId: B!.schemaId
        });
        return { tx, verify: { payloadHash: A.payloadHash, payloadHashB: B!.payloadHash, predicate: 'documentIntegrity', allowedMask: c.allowedMask } };
    }
}
