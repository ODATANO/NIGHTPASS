import cds from '@sap/cds';
import { randomBytes, createHash } from 'node:crypto';
import { Testers, Runs } from '#cds-models/demo';
import { Passports, PassportTransactions, PredicateProofLog } from '#cds-models/passport';
import { validateDemoInput, validNickname } from './lib/demo-validation';
import { feeSponsorWalletId } from './lib/producer-wallets';
import { encryptSecret, decryptSecret } from './lib/demo-crypto';
import { sendDetached, waitForJob, detachedFromRequest, explorerTxUrl } from './lib/passport-anchor';

const { INSERT, SELECT, UPDATE } = cds.ql;

/**
 * DemoService: the anonymous "Try it" surface (see docs/try-it-demo-plan.md).
 *
 * Every NIGHTGATE / ProducerService call runs under ONE fixed technical user
 * ('producer', same principal as the cockpit + ERP ingest): NIGHTGATE binds
 * wallet sessions to the userId and the 0.8.0 fee-sponsor guard is same-user
 * scoped, so the tester's acting session and the sponsor session must share a
 * principal. App-level tester identity lives in demo.Testers instead.
 *
 * Runs are serialized through one in-memory FIFO (concurrency 1): the VPS
 * proof server and the wallet worker stay healthy, and visitors get an honest
 * queue position. In-flight state is lost on restart; boot marks stale rows
 * failed (a demo run is cheap to redo).
 */
export default class DemoService extends cds.ApplicationService {
    private queue: string[] = [];
    private processing = false;

    override async init(): Promise<void> {
        this.on('startTester', this.startTester);
        this.on('createDemoPassport', this.createDemoPassport);
        this.on('demoRunStatus', this.demoRunStatus);
        this.on('demoInfo', this.demoInfo);
        // Stale queued/running rows from a previous process are unrecoverable
        // (the queue is in-memory); fail them honestly on boot.
        cds.on('served', () => {
            if (process.env.DEMO_ENABLED === 'true' && !this.encryptionKeyOk()) {
                cds.log('demo').error(
                    'DEMO_ENABLED is set but ENCRYPTION_KEY is missing or not 64 hex chars; ' +
                    'the demo stays DISABLED (tester wallet secrets must never use the dev fallback key)');
            }
            void this.failStaleRuns().catch(() => { /* best-effort */ });
            // Warm the sponsor at boot: the sponsor facade must catch up to
            // the chain tip before its first dust balance (117 guard), and
            // without this the FIRST visitor after a restart pays that wait
            // inside their attest step.
            void this.prewarmSponsor().catch((e: unknown) =>
                cds.log('demo').warn('sponsor boot prewarm failed:', (e as Error)?.message));
        });
        return super.init();
    }

    // --- config ---------------------------------------------------------------

    /**
     * The demo refuses to run without a REAL encryption key: tester wallet
     * seeds are encrypted at rest with it, and the silent all-zero dev
     * fallback would store visitor wallet secrets under a publicly known key
     * on a public host.
     */
    private encryptionKeyOk(): boolean {
        return /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY ?? '');
    }

    private enabled(): boolean {
        return process.env.DEMO_ENABLED === 'true' && this.encryptionKeyOk();
    }
    private maxPerDay(): number { return Number(process.env.DEMO_MAX_PER_DAY || 50); }
    private maxPerIpPerDay(): number { return Number(process.env.DEMO_MAX_PER_IP_PER_DAY || 3); }
    private maxPerTester(): number { return Number(process.env.DEMO_MAX_PER_TESTER || 1); }
    private maxQueue(): number { return Number(process.env.DEMO_MAX_QUEUE || 5); }
    private queueDepth(): number { return this.queue.length + (this.processing ? 1 : 0); }
    private contractAddress(): string | null { return process.env.PASSPORT_CONTRACT_ADDRESS ?? null; }

    /** Fixed technical principal for all downstream service calls (see class doc). */
    private techUser(): any {
        return new (cds.User as any)({ id: 'producer', roles: ['producer'] });
    }

    private clientKeyOf(req: cds.Request): string {
        const ip = String((req as any)?._?.req?.ip ?? 'local');
        return createHash('sha256').update(ip).digest('hex').slice(0, 32);
    }

    private todayIso(): string {
        return new Date().toISOString().slice(0, 10);
    }

    /** COUNT(*) of today's rows of an entity; shared by all daily caps so the
     *  day-boundary predicate has exactly one owner. */
    private async countToday(entity: any, where: Record<string, unknown> = {}): Promise<number> {
        const row: any = await SELECT.one.from(entity).columns('count(*) as n')
            .where({ ...where, createdAt: { '>=': `${this.todayIso()}T00:00:00Z` } } as any);
        return Number(row?.n ?? 0);
    }

    private runsToday(where: Record<string, unknown> = {}): Promise<number> {
        return this.countToday(Runs, where);
    }

    /**
     * Serializes the check-then-act cap sections. The caps are SELECT-count
     * followed by INSERT; without serialization a scripted parallel burst
     * reads the same below-limit count N times and all N proceed. One node
     * process serves the demo, so an in-process chain is sufficient.
     */
    private capLock: Promise<unknown> = Promise.resolve();
    private withCapLock<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.capLock.then(fn, fn);
        this.capLock = run.catch(() => { /* keep the chain alive */ });
        return run;
    }

    // --- actions --------------------------------------------------------------

    private startTester = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'demo is not enabled on this instance');
        const clientKey = this.clientKeyOf(req);
        // Tester creation shares the per-IP budget with runs: creating testers
        // is the cheapest thing to spam, so it is capped hardest. Fast-path
        // reject before the (slow) wallet derivation; the authoritative
        // re-check happens under the cap lock together with the INSERT.
        if (await this.countToday(Testers, { clientKey }) >= this.maxPerIpPerDay()) {
            return req.reject(429, 'daily demo budget for this address is used up, try again tomorrow');
        }

        // Fresh wallet: a random 64-byte BIP39 seed (no mnemonic round-trip
        // needed; NIGHTGATE accepts seedHex everywhere). Identity via the
        // plugin's pure derivation action.
        const seedHex = randomBytes(64).toString('hex');
        const nightgate: any = await cds.connect.to('NightgateService');
        const info: any = await nightgate.tx({ user: this.techUser() }, (tx: any) =>
            tx.send('deriveWalletInfo', { seedHex }));

        const testerId = cds.utils.uuid();
        // Cap re-check + INSERT under the in-process lock (parallel-burst
        // safe), and as a detached short root tx: the request's own snapshot
        // is stale by now (the deriveWalletInfo service call above let the
        // wallet worker's periodic facade-save commit in between), and writing
        // in a stale snapshot is the documented SQLITE_BUSY_SNAPSHOT trap.
        await this.withCapLock(async () => {
            if (await this.countToday(Testers, { clientKey }) >= this.maxPerIpPerDay()) {
                return req.reject(429, 'daily demo budget for this address is used up, try again tomorrow');
            }
            await this.detachedWrite(async () => INSERT.into(Testers).entries({
                testerId,
                nickname: validNickname((req.data as any).nickname),
                encSeedHex: encryptSecret(seedHex, testerId),
                encViewingKey: encryptSecret(String(info.viewingKey), testerId),
                shieldedAddress: String(info.shieldedAddress),
                nightAddress: String(info.nightAddress),
                clientKey,
                passportCount: 0
            } as any));
        });

        return {
            testerId,
            shieldedAddress: String(info.shieldedAddress),
            nightAddress: String(info.nightAddress)
        };
    };

    private createDemoPassport = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'demo is not enabled on this instance');
        if (!this.contractAddress()) return req.reject(503, 'no vault configured (PASSPORT_CONTRACT_ADDRESS)');

        const data = req.data as Record<string, unknown>;
        const tester: any = await SELECT.one.from(Testers)
            .where({ testerId: String(data.testerId ?? '') });
        if (!tester) return req.reject(404, 'unknown testerId (start the demo first)');

        const check = validateDemoInput(data);
        if (!check.ok) return req.reject(400, check.errors.join('; '));
        const input = check.value!;

        // All caps + the Runs INSERT run under one in-process lock: the caps
        // are check-then-act (SELECT count, then INSERT), and without
        // serialization a scripted parallel burst reads the same below-limit
        // count N times and every request proceeds. The INSERT sits inside
        // the lock so the next request's count already includes this run.
        const clientKey = this.clientKeyOf(req);
        const passportId = `BAT-TRY-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex').toUpperCase()}`;
        const runId = cds.utils.uuid();
        const thresholdScaled = Math.round(input.proveThreshold * 1000);
        const gate = await this.withCapLock(async () => {
            // Queue-length cap: with concurrency 1 every queued run is 3-5
            // minutes of wait for the ones behind it. Beyond the cap, refuse
            // honestly instead of queueing someone for an hour.
            if (this.queueDepth() >= this.maxQueue()) {
                return req.reject(429, 'the demo is busy right now, try again in a few minutes');
            }
            // Per IP and global per day first (so a rejected request does not
            // consume the tester's quota)...
            if (await this.runsToday({ clientKey }) >= this.maxPerIpPerDay()) {
                return req.reject(429, 'daily demo budget for this address is used up, try again tomorrow');
            }
            if (await this.runsToday() >= this.maxPerDay()) {
                return req.reject(429, 'the demo reached its daily on-chain budget, try again tomorrow');
            }
            // ...then the per-tester cap as an ATOMIC conditional increment:
            // the DB applies check and count in one indivisible statement, so
            // even beyond this lock two parallel submits can never both win.
            const won: any = await this.detachedWrite(async () =>
                UPDATE.entity(Testers)
                    .set({ passportCount: { '+=': 1 } } as any)
                    .where({ ID: tester.ID, passportCount: { '<': this.maxPerTester() } } as any));
            if (!won) return req.reject(429, 'this tester already created a passport');
            // (passportCount was incremented by the atomic gate just above.)
            // Detached write for the same snapshot-staleness reason as
            // startTester: the wallet worker's periodic saves commit on other
            // connections at any time, so demo writes always take their own
            // short root tx.
            await this.detachedWrite(async () => {
                await INSERT.into(Runs).entries({
                    ID: runId,
                    tester_ID: tester.ID,
                    passportId,
                    state: 'queued',
                    stepsJson: JSON.stringify(this.initialSteps()),
                    threshold: thresholdScaled,
                    clientKey
                } as any);
            });
            return true;
        });
        if (gate !== true) return;

        // Enqueue only after this request committed: the executor reads the
        // Runs row in its own root txs.
        const payload = { runId, passportId, testerRowId: tester.ID, testerId: tester.testerId, input };
        (req as any).on('succeeded', () => {
            this.queue.push(runId);
            this.pending.set(runId, payload);
            void detachedFromRequest(() => this.processQueue()).catch((e: unknown) =>
                cds.log('demo').error('queue processor crashed:', e));
        });

        return { runId, passportId, queuePosition: this.queueDepth() };
    };

    private demoRunStatus = async (req: cds.Request) => {
        // Gate before any DB access: on instances without the demo tables
        // (any DB not freshly deployed) the query would 500 with a raw
        // 'no such table' instead of an honest disabled signal.
        if (!this.enabled()) return req.reject(503, 'demo is not enabled on this instance');
        const runId = String((req.data as any).runId ?? '');
        const run: any = await SELECT.one.from(Runs)
            .columns('ID', 'passportId', 'state', 'stepsJson', 'error')
            .where({ ID: runId });
        if (!run) return req.reject(404, 'unknown runId');
        const pos = this.queue.indexOf(runId);
        return {
            passportId: run.passportId,
            state: run.state,
            stepsJson: run.stepsJson,
            error: run.error ?? '',
            queuePosition: pos >= 0 ? pos + (this.processing ? 1 : 0) : 0
        };
    };

    private demoInfo = async () => {
        // No DB access when disabled: the demo tables may not exist there.
        if (!this.enabled() || !this.contractAddress()) {
            return { enabled: false, queueDepth: 0, dailyRemaining: 0 };
        }
        const used = await this.runsToday();
        return {
            enabled: true,
            queueDepth: this.queueDepth(),
            dailyRemaining: Math.max(0, this.maxPerDay() - used)
        };
    };

    // --- run executor ---------------------------------------------------------

    /** Per-run context captured at enqueue time (never persisted). */
    private pending = new Map<string, {
        runId: string; passportId: string; testerRowId: string; testerId: string;
        input: NonNullable<ReturnType<typeof validateDemoInput>['value']>;
    }>();

    private initialSteps() {
        return [
            { kind: 'sync', label: 'Create passport & sync wallet', status: 'pending' },
            { kind: 'attest', label: 'Anchor payload hash (attest)', status: 'pending' },
            { kind: 'bindPassport', label: 'Bind passport id on-chain', status: 'pending' },
            { kind: 'anchorContentRoot', label: 'Anchor field Merkle root', status: 'pending' },
            { kind: 'provePredicate', label: 'ZK-prove CO2 claim (value hidden)', status: 'pending' },
            { kind: 'publish', label: 'Publish to the public explorer', status: 'pending' }
        ];
    }

    private async processQueue(): Promise<void> {
        if (this.processing) return;
        this.processing = true;
        try {
            for (;;) {
                const runId = this.queue.shift();
                if (!runId) break;
                const ctx = this.pending.get(runId);
                this.pending.delete(runId);
                if (!ctx) continue;
                try {
                    await this.executeRun(ctx);
                } catch (e) {
                    const msg = String((e as Error)?.message ?? e).slice(0, 480);
                    cds.log('demo').warn(`run ${runId} failed:`, e);
                    await this.patchRun(runId, { state: 'failed', error: msg }).catch(() => { /* best-effort */ });
                }
            }
        } finally {
            this.processing = false;
        }
    }

    private async executeRun(ctx: NonNullable<ReturnType<DemoService['pending']['get']>>): Promise<void> {
        const log = cds.log('demo');
        const { runId, passportId, input } = ctx;
        const user = this.techUser();
        const nightgate: any = await cds.connect.to('NightgateService');
        const producer: any = await cds.connect.to('ProducerService');
        const steps = this.initialSteps();
        // BEST-EFFORT: the timeline is cosmetic. A stepsJson UPDATE that hits
        // write-lock contention (facade saves) must never fail a run whose
        // on-chain work succeeded; the next setStep re-writes the full array
        // anyway, so a dropped intermediate write self-heals.
        const setStep = async (kind: string, patch: Record<string, unknown>) => {
            const s: any = steps.find(x => x.kind === kind);
            if (s) Object.assign(s, patch);
            try {
                await this.patchRun(runId, { stepsJson: JSON.stringify(steps) });
            } catch (e) {
                log.warn(`run ${runId}: timeline write failed (continuing):`, (e as Error)?.message);
            }
        };

        // 0. Make sure the SPONSOR session exists BEFORE the anchor: without
        //    this, a failed boot prewarm would let ProducerService open the
        //    sponsor session lazily INSIDE the write-holding createPassport
        //    tx (the documented write-lock-vs-detached-commit deadlock), and
        //    the run would silently degrade to unsponsored and die on zero
        //    dust. Failing here instead gives an honest, early error.
        const sponsorWallet = feeSponsorWalletId();
        if (sponsorWallet) {
            const warm: any = await producer.tx({ user }, (tx: any) =>
                tx.send('prewarmServerWallet', { walletId: sponsorWallet }));
            if (warm?.state === 'error') {
                throw new Error(`fee sponsor '${sponsorWallet}' unavailable: ${warm?.error || 'no signing session'}`);
            }
        }

        // 1. Wallet: open the tester's signing session + wait for sync.
        await this.patchRun(runId, { state: 'wallet' });
        await setStep('sync', { status: 'running' });
        const tester: any = await SELECT.one.from(Testers).where({ ID: ctx.testerRowId });
        const seedHex = decryptSecret(tester.encSeedHex, tester.testerId);
        const viewingKey = decryptSecret(tester.encViewingKey, tester.testerId);
        const conn: any = await sendDetached(nightgate, 'connectWallet', { viewingKey }, user);
        const sessionId = String(conn.sessionId);
        try {
            // With NIGHTGATE_SPONSORED_CALLER_SYNC=skip (0.8.1) a fresh
            // caller wallet needs no chain sync at all: connect with
            // prewarm:false so NO background sync job races the submission's
            // on-demand facade init, the caller balance wait is skipped, and
            // the sponsor carries the fees. Without the skip opt-in, keep the
            // classic prewarm + wait.
            const skipCallerSync = process.env.NIGHTGATE_SPONSORED_CALLER_SYNC === 'skip';
            const signing: any = await sendDetached(nightgate, 'connectWalletForSigning',
                { sessionId, seedHex, ...(skipCallerSync ? { prewarm: false } : {}) }, user);
            if (signing?.prewarmJobId && !skipCallerSync) {
                log.info(`run ${runId}: waiting for tester wallet sync...`);
                await waitForJob(nightgate, String(signing.prewarmJobId), sessionId, user);
            }
            await setStep('sync', { status: 'succeeded' });

            // 2. Create + anchor through the standard cockpit action. MANAGED
            //    tx (callback form) so its 'succeeded' event fires and the
            //    detached anchor runner actually starts (ERP-ingest lesson).
            //    The explicit sessionId makes ProducerService use the tester's
            //    session, and PASSPORT_FEE_SPONSOR_WALLET on this instance
            //    makes the sponsor pay all three anchor fees.
            await this.patchRun(runId, { state: 'anchoring' });
            await setStep('attest', { status: 'running' });
            const passportJson = JSON.stringify({
                passportId,
                manufacturerId: input.manufacturer,
                batteryCategory: 'EV',
                model: input.model,
                manufactureDate: new Date().toISOString().slice(0, 10),
                weightKg: input.weightKg,
                performanceClass: input.performanceClass,
                batteries: [{
                    serialNumber: `TRY-${randomBytes(4).toString('hex')}`,
                    cellChemistry: 'Li-ion NMC',
                    // Fixed demo value: capacity is a recycler-tier field the
                    // visitor never sees; their public fields are model,
                    // manufacturer, weight and performance class.
                    capacityKwh: 60,
                    carbonFootprintKgCO2: input.co2Kg
                }]
            });
            const created: any = await producer.tx({ user }, (tx: any) => tx.send('createPassport', {
                passportJson, submit: true, owner: tester.shieldedAddress, sessionId
            }));
            if (created?.mode !== 'anchoring') {
                throw new Error(`createPassport returned mode '${created?.mode}' (expected 'anchoring')`);
            }

            // Poll the passport row + its tx log; flip timeline steps as tx hashes land.
            const row = await this.pollAnchor(runId, passportId, setStep);
            if (row.status !== 'anchored') {
                throw new Error(`anchor failed (passport status '${row.status}')`);
            }

            // 3. ZK proof of the CO2 claim (sponsored the same way).
            await this.patchRun(runId, { state: 'proving' });
            await setStep('provePredicate', { status: 'running' });
            const prove: any = await producer.tx({ user }, (tx: any) => tx.send('provePassportValue', {
                passportId,
                sourceField: 'carbonFootprintKgCO2',
                predicate: 'lessOrEqual',
                threshold: input.proveThreshold,
                unit: 'kg CO2e',
                sessionId
            }));
            if (prove?.mode !== 'proving') throw new Error(`provePassportValue returned mode '${prove?.mode}'`);
            const proof = await this.pollProof(String(prove.proofLogId));
            if (proof.status !== 'succeeded') throw new Error('predicate proof failed');
            await setStep('provePredicate', {
                status: 'succeeded', txHash: proof.txHash, explorerUrl: explorerTxUrl(proof.txHash)
            });

            // 4. Publish into the public explorer. NEVER fatal: the passport
            //    is anchored and proven at this point, and publishPassport can
            //    also REJECT (e.g. 503 when PASSPORT_PUBLISH_SECRET is
            //    missing), which would otherwise fail a fully successful run.
            await this.patchRun(runId, { state: 'publishing' });
            if (process.env.PASSPORT_PUBLISH_URL) {
                await setStep('publish', { status: 'running' });
                let published = false;
                try {
                    const pub: any = await producer.tx({ user }, (tx: any) => tx.send('publishPassport', { passportId }));
                    published = !!pub?.published;
                    if (!published) log.warn(`run ${runId}: publish failed: ${pub?.status}`);
                } catch (e) {
                    log.warn(`run ${runId}: publish rejected (continuing):`, (e as Error)?.message);
                }
                await setStep('publish', { status: published ? 'succeeded' : 'failed' });
            } else {
                await setStep('publish', { status: 'skipped' });
            }

            await this.patchRun(runId, { state: 'done' });
            log.info(`run ${runId}: ${passportId} done`);
        } finally {
            // Memory hygiene: every visitor otherwise leaves a wallet facade
            // behind in the worker forever. Disconnecting evicts the facade
            // (with a final state save) and deactivates the session; a later
            // run for the same tester simply reconnects from the stored
            // secrets. Retried on write contention (the evict's own final
            // multi-MB facade save can hold the write lock past the busy
            // timeout). FIRE-AND-FORGET: the retry sleeps must not delay the
            // next queued visitor's run; nothing downstream depends on this
            // per-run session, so the queue can advance immediately.
            void (async () => {
                for (let attempt = 0; attempt < 3; attempt++) {
                    if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
                    try {
                        await sendDetached(nightgate, 'disconnectWallet', { sessionId }, user);
                        log.info(`run ${runId}: tester session ${sessionId.slice(0, 8)}... disconnected (facade evicted)`);
                        return;
                    } catch (e) {
                        const msg = String((e as Error)?.message ?? e);
                        log.warn(`run ${runId}: tester session cleanup attempt ${attempt + 1} failed:`, msg);
                        if (!/database is locked|SQLITE_BUSY/i.test(msg)) return;
                    }
                }
            })();
        }
    }

    /**
     * Poll the anchoring passport until 'anchored'/'failed' (20 min cap),
     * mirroring the three anchor steps into the timeline as their
     * PassportTransactions rows appear.
     */
    private async pollAnchor(
        runId: string, passportId: string,
        setStep: (kind: string, patch: Record<string, unknown>) => Promise<void>
    ): Promise<{ status: string }> {
        const deadline = Date.now() + 20 * 60_000;
        const seen = new Set<string>();
        for (;;) {
            await new Promise(r => setTimeout(r, 5000));
            const row: any = await SELECT.one.from(Passports)
                .columns('ID', 'status').where({ passportId });
            const txs: any[] = row
                ? await SELECT.from(PassportTransactions)
                    .columns('kind', 'txHash', 'status').where({ passport_ID: row.ID })
                : [];
            for (const t of txs) {
                if (t.status === 'succeeded' && t.txHash && !seen.has(t.kind)) {
                    seen.add(t.kind);
                    await setStep(t.kind, {
                        status: 'succeeded', txHash: t.txHash, explorerUrl: explorerTxUrl(t.txHash)
                    });
                    // The next pending anchor step is now the running one.
                    const order = ['attest', 'bindPassport', 'anchorContentRoot'];
                    const next = order.find(k => !seen.has(k));
                    if (next) await setStep(next, { status: 'running' });
                }
            }
            if (row?.status === 'anchored' || row?.status === 'failed') return row;
            if (Date.now() > deadline) throw new Error('anchor timed out');
        }
    }

    /** Poll the PredicateProofLog row to completion (10 min cap). */
    private async pollProof(proofLogId: string): Promise<{ status: string; txHash?: string }> {
        const deadline = Date.now() + 10 * 60_000;
        for (;;) {
            await new Promise(r => setTimeout(r, 5000));
            const row: any = await SELECT.one.from(PredicateProofLog)
                .columns('status', 'txHash').where({ ID: proofLogId });
            if (row && row.status !== 'pending') return row;
            if (Date.now() > deadline) throw new Error('proof timed out');
        }
    }

    /**
     * Short detached root tx for writes (see the snapshot notes above), with
     * a bounded retry on sqlite write contention: the wallet worker's
     * periodic multi-MB facade saves can hold the write lock past the busy
     * timeout, and a visitor request colliding with one must not surface a
     * raw 500 (seen live: a double-submit got SQLITE_BUSY instead of 429).
     */
    private async detachedWrite<T>(fn: () => Promise<T>): Promise<T> {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
            try {
                return await (cds as any).tx({}, fn);
            } catch (e) {
                lastErr = e;
                if (!/database is locked|SQLITE_BUSY/i.test(String((e as Error)?.message ?? e))) break;
            }
        }
        throw lastErr;
    }

    private patchRun(runId: string, patch: Record<string, unknown>): Promise<unknown> {
        return this.detachedWrite(() =>
            UPDATE.entity(Runs).set(patch).where({ ID: runId }) as any);
    }

    /** Kick the fee-sponsor wallet's session + sync at boot (non-blocking). */
    private async prewarmSponsor(): Promise<void> {
        const sponsorWallet = feeSponsorWalletId();
        if (!this.enabled() || !sponsorWallet) return;
        const producer: any = await cds.connect.to('ProducerService');
        await producer.tx({ user: this.techUser() }, (tx: any) =>
            tx.send('prewarmServerWallet', { walletId: sponsorWallet }));
        cds.log('demo').info(`fee sponsor '${sponsorWallet}' prewarm kicked at boot`);
    }

    private async failStaleRuns(): Promise<void> {
        await (cds as any).tx({}, () =>
            UPDATE.entity(Runs)
                .set({ state: 'failed', error: 'server restarted while the run was in flight' })
                .where({ state: { in: ['queued', 'wallet', 'anchoring', 'proving', 'publishing'] } }));
    }
}
