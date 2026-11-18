import cds from '@sap/cds';
import { randomBytes, createHash } from 'node:crypto';
import { Testers, Runs } from '#cds-models/demo';
import { Passports, PassportTransactions, PredicateProofLog } from '#cds-models/passport';
import { validateDemoInput, validNickname } from './lib/demo-validation';
import {
    DEMO_PROFILES, demoProfile, demoClaimList, demoChildRows, membershipSetFor, type ResolvedClaim,
} from './lib/demo-claims';
import type { AttributeRow } from '@odatano/dpp-sdk/attributes';
import { encryptSecret, decryptSecret } from './lib/demo-crypto';
import { detachedFromRequest, explorerTxUrl, blake2b256Hex } from './lib/passport-anchor';
import {
    chainLaneConfigured, remoteIdentity, remoteLaneConfigFromEnv, remoteLaneFor, registerRemoteSigner, releaseRemoteSigner,
    ensureRemoteZkAssets, hostedVerifyClient, type RemoteChainLane
} from './lib/lane-remote';

const { INSERT, SELECT, UPDATE } = cds.ql;

/**
 * DemoService: the anonymous "Try it" surface. Every ProducerService call runs
 * under one technical user; the tester's identity lives in demo.Testers. Runs
 * queue in memory, so a restart loses the ones in flight and boot fails them.
 */
export default class DemoService extends cds.ApplicationService {
    private queue: string[] = [];
    /** runIds currently executing (semaphore up to concurrency()). */
    private running = new Set<string>();

    override async init(): Promise<void> {
        this.on('startTester', this.startTester);
        this.on('createDemoPassport', this.createDemoPassport);
        this.on('demoRunStatus', this.demoRunStatus);
        this.on('demoInfo', this.demoInfo);
        this.on('demoSponsorStatus', this.demoSponsorStatus);
        this.on('demoClaimFields', this.demoClaimFields);
        this.on('demoProfiles', this.demoProfiles);
        // Stale queued/running rows from a previous process are unrecoverable
        // (the queue is in-memory); fail them honestly on boot.
        cds.on('served', () => {
            if (process.env.DEMO_ENABLED === 'true') {
                const log = cds.log('demo');
                if (!this.encryptionKeyOk()) {
                    log.error(
                        'DEMO_ENABLED is set but ENCRYPTION_KEY is missing or not 64 hex chars; ' +
                        'the demo stays DISABLED (tester wallet secrets must never use the dev fallback key)');
                }
                if (!chainLaneConfigured()) {
                    log.error('DEMO_ENABLED is set but NIGHTGATE_API_URL or NIGHTGATE_AGENT_TOKEN is missing; the demo stays DISABLED');
                }
                if (!this.vaultPool().length) {
                    log.error('DEMO_ENABLED is set but PASSPORT_CONTRACT_ADDRESSES and PASSPORT_CONTRACT_ADDRESS name no vault (64 hex); the demo stays DISABLED');
                }
            }
            void this.failStaleRuns().catch(() => { /* best-effort */ });
            // Under parallel runs, write bursts exceed the default 5s busy timeout.
            // Let writers queue longer instead of failing with 'database is locked'.
            void (async () => {
                try {
                    const db: any = await cds.connect.to('db');
                    if (typeof db.pragma === 'function') await db.pragma('busy_timeout = 15000');
                } catch { /* non-sqlite or pragma unsupported */ }
            })();
            this.startHostedSponsorProbe();
            if (this.enabled()) {
                void ensureRemoteZkAssets()
                    .then((r) => cds.log('demo').info(`prover keys ready (${r.fetched} fetched, ${r.cached} cached)`))
                    .catch((e: unknown) => cds.log('demo').warn('prover key warm-up failed:', (e as Error)?.message));
            }
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

    /** Without the API and its grant no run can reach the chain, so the demo counts as off. */
    private enabled(): boolean {
        return process.env.DEMO_ENABLED === 'true' && this.encryptionKeyOk() && chainLaneConfigured();
    }
    private maxPerDay(): number { return Number(process.env.DEMO_MAX_PER_DAY || 50); }
    private maxPerIpPerDay(): number { return Number(process.env.DEMO_MAX_PER_IP_PER_DAY || 5); }
    private maxPerTester(): number { return Number(process.env.DEMO_MAX_PER_TESTER || 1); }
    private maxQueue(): number { return Number(process.env.DEMO_MAX_QUEUE || 5); }
    private queueDepth(): number { return this.queue.length + this.running.size; }

    /** How many runs may execute in parallel. The API's pool sponsors in parallel, so proving capacity is the bound. */
    private concurrency(): number {
        return Math.max(1, Number(process.env.DEMO_CONCURRENCY) || 1);
    }

    /**
     * Minimum spacing between run STARTS. A run's opening phase is
     * write-heavy (createPassport deep-inserts ~65 attribute rows plus the
     * content root inside one tx); measured under 3 truly simultaneous
     * starts, those transactions pile up on SQLite's single write lock and
     * starve the visitor-facing requests. Staggering the starts keeps at
     * most one heavy phase active while the runs' LONG chain-wait phases
     * still overlap, which is where the parallel throughput actually lives.
     */
    private startStaggerMs(): number {
        // With a vault pool the runs write distinct contracts, so they may start almost back to back.
        const dflt = this.vaultPool().length > 1 ? 5_000 : 45_000;
        return Number(process.env.DEMO_START_STAGGER_MS || dflt);
    }
    private lastStartAt = 0;
    private staggerTimer: NodeJS.Timeout | null = null;
    /** Default vault (the first of the pool). */
    private contractAddress(): string | null { return this.vaultPool()[0] ?? null; }
    /** Vaults visitor runs are spread over: PASSPORT_CONTRACT_ADDRESSES (comma list), else the single PASSPORT_CONTRACT_ADDRESS. */
    private vaultPool(): string[] {
        const list = String(process.env.PASSPORT_CONTRACT_ADDRESSES?.trim() || process.env.PASSPORT_CONTRACT_ADDRESS || '')
            .split(',').map((v) => v.trim().toLowerCase()).filter((v) => /^[0-9a-f]{64}$/.test(v));
        return [...new Set(list)];
    }
    private vaultLeases = new Map<string, string>();
    /** The vault with the fewest runs in flight; every run gets one. */
    private acquireVault(runId: string): string | null {
        const pool = this.vaultPool();
        if (!pool.length) return null;
        const load = new Map(pool.map((v) => [v, 0]));
        for (const v of this.vaultLeases.values()) if (load.has(v)) load.set(v, (load.get(v) ?? 0) + 1);
        const pick = pool.reduce((best, v) => ((load.get(v) ?? 0) < (load.get(best) ?? 0) ? v : best), pool[0]);
        this.vaultLeases.set(runId, pick);
        return pick;
    }

    /** Fixed technical principal for all downstream service calls (see class doc). */
    private techUser(): any {
        return new (cds.User as any)({ id: 'producer', roles: ['producer'] });
    }

    private clientKeyOf(req: cds.Request): string {
        const ip = String((req as any)?._?.req?.ip ?? 'local');
        return createHash('sha256').update(ip).digest('hex').slice(0, 32);
    }

    /**
     * IPs exempt from the per-IP cap (comma list in DEMO_IP_ALLOWLIST, e.g.
     * the maintainers' own address for live smoke tests). The global daily
     * cap and the per-tester cap still apply to allowlisted addresses.
     */
    private ipExemptFromCap(req: cds.Request): boolean {
        const list = String(process.env.DEMO_IP_ALLOWLIST || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        if (!list.length) return false;
        return list.includes(String((req as any)?._?.req?.ip ?? ''));
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

    /**
     * The tester's on-chain identity for a fresh seed: attester id and night
     * address, derived without a builder or the network. The attester id
     * doubles as the owner scope of the passport.
     */
    private async testerIdentity(seedHex: string): Promise<{ shieldedAddress: string; nightAddress: string }> {
        const id = await remoteIdentity(remoteLaneConfigFromEnv(), seedHex);
        return { shieldedAddress: id.attesterId, nightAddress: id.nightAddress };
    }

    private startTester = async (req: cds.Request) => {
        if (!this.enabled()) return req.reject(503, 'demo is not enabled on this instance');
        const clientKey = this.clientKeyOf(req);
        // Tester creation shares the per-IP budget with runs: creating testers
        // is the cheapest thing to spam, so it is capped hardest. Fast-path
        // reject before the (slow) wallet derivation; the authoritative
        // re-check happens under the cap lock together with the INSERT.
        const ipExempt = this.ipExemptFromCap(req);
        if (!ipExempt && await this.countToday(Testers, { clientKey }) >= this.maxPerIpPerDay()) {
            return req.reject(429, 'daily demo budget for this address is used up, try again tomorrow');
        }

        // Fresh identity: a random 64-byte seed, which the transaction builder takes as it is.
        const seedHex = randomBytes(64).toString('hex');
        const info = await this.testerIdentity(seedHex);

        const testerId = cds.utils.uuid();
        // Cap re-check and INSERT under the in-process lock, in a short root tx of their own.
        await this.withCapLock(async () => {
            if (!ipExempt && await this.countToday(Testers, { clientKey }) >= this.maxPerIpPerDay()) {
                return req.reject(429, 'daily demo budget for this address is used up, try again tomorrow');
            }
            await this.detachedWrite(async () => INSERT.into(Testers).entries({
                testerId,
                nickname: validNickname((req.data as any).nickname),
                encSeedHex: encryptSecret(seedHex, testerId),
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

        // Head and claims arrive as JSON strings (CAP actions take no
        // struct params); a malformed body is a plain 400, not a 500.
        let claims: unknown, head: unknown;
        try {
            claims = data.claimsJson ? JSON.parse(String(data.claimsJson)) : [];
            head = data.headJson ? JSON.parse(String(data.headJson)) : {};
        } catch { return req.reject(400, 'headJson and claimsJson must be valid JSON'); }

        const check = validateDemoInput({ profile: data.profile, head, claims, secondLife: data.secondLife });
        if (!check.ok) return req.reject(400, check.errors.join('; '));
        const input = check.value!;
        const claimList = demoClaimList(input.profile, input.claims);
        const primary = claimList.find((c) => c.field === input.profile.primary);
        if (!primary || primary.predicate === 'setMembership') return req.reject(400, 'the primary claim must be numeric');

        // All caps + the Runs INSERT run under one in-process lock: the caps
        // are check-then-act (SELECT count, then INSERT), and without
        // serialization a scripted parallel burst reads the same below-limit
        // count N times and every request proceeds. The INSERT sits inside
        // the lock so the next request's count already includes this run.
        const clientKey = this.clientKeyOf(req);
        const passportId = `${input.profile.idPrefix}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex').toUpperCase()}`;
        const runId = cds.utils.uuid();
        const thresholdScaled = Math.round(primary.threshold * 1000);
        const gate = await this.withCapLock(async () => {
            // Queue-length cap: with concurrency 1 every queued run is 3-5
            // minutes of wait for the ones behind it. Beyond the cap, refuse
            // honestly instead of queueing someone for an hour.
            if (this.queueDepth() >= this.maxQueue()) {
                return req.reject(429, 'the demo is busy right now, try again in a few minutes');
            }
            // Per IP and global per day first (so a rejected request does not
            // consume the tester's quota)...
            if (!this.ipExemptFromCap(req) && await this.runsToday({ clientKey }) >= this.maxPerIpPerDay()) {
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
            // The run row takes a short root tx of its own, like the tester row.
            await this.detachedWrite(async () => {
                await INSERT.into(Runs).entries({
                    ID: runId,
                    tester_ID: tester.ID,
                    passportId,
                    state: 'queued',
                    stepsJson: JSON.stringify(this.initialSteps(input.secondLife, claimList)),
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
            this.processQueue();
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
        return {
            passportId: run.passportId,
            state: run.state,
            stepsJson: run.stepsJson,
            error: run.error ?? '',
            ...this.queueViewFor(runId)
        };
    };

    /**
     * Honest queue view for the UI. Runs admitted into a free slot still wait
     * out the start stagger, which used to render as "queue position N" even
     * though nobody was actually ahead of them. Distinguish the two cases:
     * startingInSec >= 0 means only the stagger is ticking (estimated start
     * countdown), -1 means the run really waits for a slot to free up.
     * queuePosition stays for API compatibility.
     */
    private queueViewFor(runId: string) {
        const pos = this.queue.indexOf(runId);
        const runningCount = this.running.size;
        if (pos < 0) return { runningCount, waitingAhead: 0, startingInSec: 0, queuePosition: 0 };
        let startingInSec = -1;
        if (pos < this.concurrency() - runningCount || runningCount === 0) {
            const eta = this.lastStartAt + this.startStaggerMs() * (pos + 1) - Date.now();
            startingInSec = Math.max(0, Math.ceil(eta / 1000));
        }
        return { runningCount, waitingAhead: pos, startingInSec, queuePosition: pos + runningCount };
    }

    private demoInfo = async () => {
        // No DB access when disabled: the demo tables may not exist there.
        if (!this.enabled() || !this.contractAddress()) {
            return { enabled: false, queueDepth: 0, dailyRemaining: 0, runningCount: 0, waitingCount: 0 };
        }
        const used = await this.runsToday();
        return {
            enabled: true,
            queueDepth: this.queueDepth(),
            runningCount: this.running.size,
            waitingCount: this.queue.length,
            dailyRemaining: Math.max(0, this.maxPerDay() - used)
        };
    };

    /** The product families and their head fields (see demo-service.cds). Static, DB-free. */
    private demoProfiles = async () => Object.values(DEMO_PROFILES).map((p) => ({
        id: p.id, label: p.label, tagline: p.tagline, regulation: p.regulation, idPrefix: p.idPrefix,
        primaryField: p.primary, secondLife: p.secondLife, headJson: JSON.stringify(p.head),
    }));

    /** Claim catalogue of one family for the form (see demo-service.cds). Static, DB-free. */
    private demoClaimFields = async (req: cds.Request) => {
        let profile;
        try { profile = demoProfile((req.data as { profile?: string }).profile); }
        catch (e) { return req.reject(400, (e as Error).message); }
        return profile.claims.map((c) => (c.kind === 'membership'
            ? {
                field: c.field, label: c.label, kind: 'membership',
                setId: c.setId, setLabel: membershipSetFor(c)?.label ?? c.setId,
                optionsJson: JSON.stringify(membershipSetFor(c)?.values ?? []),
                defaultOption: c.defaultValue,
                primary: false
            }
            : {
                field: c.field, label: c.label, kind: 'numeric', unit: c.unit, predicate: c.predicate,
                min: c.min, max: c.max, defaultValue: c.defaultValue, defaultThreshold: c.defaultThreshold,
                primary: c.field === profile.primary
            }));
    };

    /** The API's sponsor pool as one gauge row, from the cached background probe. Empty when the demo is off. */
    private demoSponsorStatus = async () => {
        if (!this.enabled()) return [];
        return [this.hostedSponsorRow()];
    };

    // --- sponsor probe ---------------------------------------------------------

    private hostedProbe: { state: 'cold' | 'ready' | 'error'; error: string; at: number } = { state: 'cold', error: '', at: 0 };
    private hostedProbeTimer?: ReturnType<typeof setInterval>;

    /**
     * The only read the agent token may make is the verify surface, so the
     * probe is a verifyAttestationState on the demo vault (a zero hash, so
     * the answer is a cheap `verified:false`). Cold the first read builds
     * the hosted provider bundle (~1 min); warm it is sub-second. Runs in
     * the background every DEMO_SPONSOR_WATCHDOG_MS (default 60 s here).
     */
    private startHostedSponsorProbe(): void {
        if (!this.enabled()) return;
        const interval = Number(process.env.DEMO_SPONSOR_WATCHDOG_MS?.trim() || 60_000);
        const tick = async () => {
            const contractAddress = this.contractAddress();
            try {
                const ng = await hostedVerifyClient(remoteLaneConfigFromEnv());
                await ng.callFunction('verifyAttestationState', {
                    contractAddress: contractAddress ?? undefined,
                    attesterId: '0'.repeat(64), payloadHash: '0'.repeat(64), compiledArtifactRef: 'attestation-vault'
                });
                this.hostedProbe = { state: 'ready', error: '', at: Date.now() };
            } catch (e) {
                const msg = String((e as Error)?.message ?? e).slice(0, 200);
                this.hostedProbe = { state: 'error', error: msg, at: Date.now() };
                cds.log('demo').warn('hosted sponsor probe failed:', msg);
            }
        };
        void tick();
        if (interval > 0) {
            this.hostedProbeTimer = setInterval(() => void tick(), interval);
            this.hostedProbeTimer.unref?.();
        }
    }

    private hostedSponsorRow() {
        const p = this.hostedProbe;
        return {
            walletId: 'hosted', label: 'hosted sponsor pool',
            state: p.state === 'cold' ? 'warming' : p.state,
            nightDisplay: '', dustPresent: p.state === 'ready', registeredNightUtxos: 0,
            healthy: p.state === 'ready', error: p.error
        };
    }

    // --- run executor ---------------------------------------------------------

    /** Per-run context captured at enqueue time (never persisted). */
    private pending = new Map<string, {
        runId: string; passportId: string; testerRowId: string; testerId: string;
        input: NonNullable<ReturnType<typeof validateDemoInput>['value']>;
    }>();

    /** Whether runs pre-register the passport id on-chain. Opt-in: it needs the registrar wallet on this instance. */
    private registerOwnershipEnabled(): boolean {
        return /^(true|1|yes|on)$/i.test(String(process.env.DEMO_REGISTER_OWNERSHIP ?? ''));
    }

    private initialSteps(secondLife = false, claims: ResolvedClaim[] = []) {
        // More than one claim renders like the anchor batch above: one step
        // per claim, grouped by the UI, all sharing the single proof tx. The
        // label IS the public statement the proof makes; the value never
        // appears anywhere.
        const statement = (c: ResolvedClaim) => c.predicate === 'setMembership'
            ? `${c.label}: one of the ${c.setLabel.toLowerCase()}`
            : `${c.label}: ${c.predicate === 'lessOrEqual' ? 'at most' : 'at least'} ${c.threshold} ${c.unit}`;
        const claimSteps = claims.length > 1
            ? claims.map((c) => ({ kind: `prove:${c.field}`, label: statement(c), status: 'pending' }))
            : [{ kind: 'provePredicate', label: claims[0] ? `ZK-prove ${statement(claims[0])}` : 'ZK-prove the primary claim', status: 'pending' }];
        return [
            { kind: 'sync', label: 'Create passport & derive keys', status: 'pending' },
            ...(this.registerOwnershipEnabled()
                ? [{ kind: 'registerPassport', label: 'Register passport ownership', status: 'pending' }]
                : []),
            { kind: 'attest', label: 'Anchor the fingerprint (attest)', status: 'pending' },
            { kind: 'anchorContentRoot', label: 'Anchor the salted field tree root', status: 'pending' },
            { kind: 'bindDocument', label: 'Bind the passport id to the fingerprint', status: 'pending' },
            ...claimSteps,
            ...(secondLife
                ? [{ kind: 'secondLife', label: 'Second life: age & repurpose (version 2)', status: 'pending' }]
                : []),
            { kind: 'publish', label: 'Publish to the public explorer', status: 'pending' }
        ];
    }

    /** Starts queued runs while slots are free. Every finished run calls it again, so the queue drains without a loop. */
    private processQueue(): void {
        while (this.queue.length && this.running.size < this.concurrency()) {
            // Stagger starts (see startStaggerMs): the first run of an idle
            // instance starts immediately, further parallel starts wait out
            // the spacing via a single rearm timer.
            const wait = this.lastStartAt + this.startStaggerMs() - Date.now();
            if (this.running.size > 0 && wait > 0) {
                if (!this.staggerTimer) {
                    this.staggerTimer = setTimeout(() => {
                        this.staggerTimer = null;
                        this.processQueue();
                    }, wait + 50);
                    this.staggerTimer.unref?.();
                }
                return;
            }
            this.lastStartAt = Date.now();
            const runId = this.queue.shift()!;
            const ctx = this.pending.get(runId);
            this.pending.delete(runId);
            if (!ctx) continue;
            const vault = this.acquireVault(runId);
            this.running.add(runId);
            void detachedFromRequest(() => this.executeRun(ctx, vault ?? undefined))
                .catch(async (e: unknown) => {
                    const msg = String((e as Error)?.message ?? e).slice(0, 480);
                    cds.log('demo').warn(`run ${runId} failed:`, e);
                    await this.patchRun(runId, { state: 'failed', error: msg }).catch(() => { /* best-effort */ });
                })
                .finally(() => {
                    this.running.delete(runId);
                    this.vaultLeases.delete(runId);
                    this.processQueue();
                });
        }
    }

    private async executeRun(
        ctx: NonNullable<ReturnType<DemoService['pending']['get']>>,
        vault?: string
    ): Promise<void> {
        const log = cds.log('demo');
        const { runId, passportId, input } = ctx;
        const user = this.techUser();
        const producer: any = await cds.connect.to('ProducerService');
        const claims = demoClaimList(input.profile, input.claims);
        const steps = this.initialSteps(input.secondLife, claims);
        // Best effort: a failed timeline write must never fail a run whose
        // on-chain work succeeded. The next setStep writes the full array again.
        const setSteps = async (patches: Array<[string, Record<string, unknown>]>) => {
            for (const [kind, patch] of patches) {
                const s: any = steps.find(x => x.kind === kind);
                if (s) Object.assign(s, patch);
            }
            try {
                await this.patchRun(runId, { stepsJson: JSON.stringify(steps) });
            } catch (e) {
                log.warn(`run ${runId}: timeline write failed (continuing):`, (e as Error)?.message);
            }
        };
        const setStep = (kind: string, patch: Record<string, unknown>) => setSteps([[kind, patch]]);

        // 1. Signer: the seed stays in this process for the run. The run id
        //    doubles as the signer handle (the actions type it as UUID) and
        //    routes every producer action of this run to the tester's seed.
        await this.patchRun(runId, { state: 'wallet' });
        await setStep('sync', { status: 'running' });
        const tester: any = await SELECT.one.from(Testers).where({ ID: ctx.testerRowId });
        const seedHex = decryptSecret(tester.encSeedHex, tester.testerId);
        const sessionId = runId;
        const contractAddress = vault ?? this.contractAddress() ?? undefined;
        registerRemoteSigner(sessionId, seedHex, { contractAddress });
        if (vault) log.info(`run ${runId}: vault ${vault.slice(0, 8)}... (${this.vaultPool().length} in the pool)`);
        try {
            await setStep('sync', { status: 'succeeded' });

            // 1b. Pre-register passport ownership: the registrar assigns the
            //     passport id to the TESTER's attester identity BEFORE the
            //     first bind, so the id cannot be taken by someone else.
            //     NEVER fatal: an unregistered id still binds first-come.
            if (this.registerOwnershipEnabled()) {
                await setStep('registerPassport', { status: 'running' });
                let registrar: RemoteChainLane | null = null;
                try {
                    if (!contractAddress) throw new Error('no vault configured');
                    const sess: any = await producer.tx({ user }, (tx: any) =>
                        tx.send('serverWalletSession', { walletId: process.env.PASSPORT_REGISTRAR_WALLET || 'default' }));
                    const { attesterId } = await remoteIdentity(remoteLaneConfigFromEnv(), seedHex);
                    registrar = remoteLaneFor(String(sess.sessionId));
                    const res = await registrar.submitVaultTx({
                        contractAddress,
                        tx: { label: 'registerDocument', calls: [{ circuit: 'registerDocument', args: ['0', blake2b256Hex(passportId), attesterId] }] }
                    });
                    await setStep('registerPassport', {
                        status: 'succeeded', txHash: res.txHash, explorerUrl: explorerTxUrl(res.txHash)
                    });
                } catch (e) {
                    log.warn(`run ${runId}: ownership registration failed (continuing unregistered):`, (e as Error)?.message);
                    await setStep('registerPassport', { status: 'failed' });
                } finally {
                    await registrar?.dispose().catch(() => { /* nothing left to release */ });
                }
            }

            // 2. Create + anchor through the standard cockpit action. MANAGED
            //    tx (callback form) so its 'succeeded' event fires and the
            //    detached anchor runner actually starts (ERP-ingest lesson).
            //    The explicit sessionId makes ProducerService sign with the
            //    tester's seed; the API's pool pays the fees.
            await this.patchRun(runId, { state: 'anchoring' });
            await setStep('attest', { status: 'running' });
            // Public head: the visitor's column values plus the family's fixed
            // ones; select heads that target an attribute become public
            // attribute rows. Confidential content: the family's child rows
            // with the claimed values placed (demoChildRows). None of those
            // reach the public explorer row; only the proven predicates do.
            const today = new Date().toISOString().slice(0, 10);
            const headColumns: Record<string, string | number> = {};
            const headAttributes: AttributeRow[] = [];
            for (const f of input.profile.head) {
                const v = input.head[f.name];
                if (f.target === 'attribute') {
                    headAttributes.push({ section: 'Identification', attribute: f.name, valueJson: JSON.stringify(String(v)), accessClass: 'public' });
                } else {
                    headColumns[f.name] = v;
                }
            }
            const attributes = [...headAttributes, ...input.profile.fixedAttributes];
            const passportJson = JSON.stringify({
                passportId,
                profile: input.profile.id,
                ...input.profile.fixedHead,
                ...headColumns,
                manufactureDate: today,
                ...(attributes.length ? { attributes } : {}),
                ...demoChildRows(input.profile, input.claims, { nonce: randomBytes(4).toString('hex'), today }),
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

            // 3. ZK proofs (sponsored the same way). The footprint claim is
            //    always there; the visitor can add more. ALL of them ride in
            //    ONE transaction, so N claims cost one wait and one fee.
            await this.patchRun(runId, { state: 'proving' });
            const multiClaim = claims.length > 1;
            const proveKind = (field: string) => multiClaim ? `prove:${field}` : 'provePredicate';
            await setSteps(claims.map((c) => [proveKind(c.field), { status: 'running' }] as [string, Record<string, unknown>]));
            const prove: any = await producer.tx({ user }, (tx: any) => tx.send('provePassportValuesBatch', {
                passportId,
                claimsJson: JSON.stringify(claims.map((c) => (c.predicate === 'setMembership'
                    ? { sourceField: c.field, predicate: 'setMembership', setId: c.setId }
                    : { sourceField: c.field, predicate: c.predicate, threshold: c.threshold, unit: c.unit }))),
                sessionId
            }));
            if (prove?.mode !== 'proving') throw new Error(`provePassportValuesBatch returned mode '${prove?.mode}'`);
            const proofIds: string[] = JSON.parse(String(prove.proofLogIds ?? '[]'));
            // Wait for EVERY claim, not just the first: a post-submit partial
            // success settles per claim, and reporting the first as the whole
            // batch would be exactly the green lie the batch path avoids.
            // Budget scales with the cart: proving is per claim, and a 1014
            // retry (the proof batch races the anchor tx's dust settlement)
            // costs a backoff plus a full re-prove on top.
            const proofTimeoutMs = (10 + 5 * Math.max(0, proofIds.length - 1)) * 60_000;
            const proofs = await Promise.all(proofIds.map((id) => this.pollProof(id, proofTimeoutMs)));
            const okProofs = proofs.filter((p) => p.status === 'succeeded');
            if (!okProofs.length) throw new Error('predicate proofs failed');
            if (multiClaim) {
                // One step per claim (grouped in the UI like the anchor
                // batch); each reports its own outcome, all share the tx.
                await setSteps(claims.map((c, i) => {
                    const p = proofs.find((x) => x.sourceField === c.field) ?? proofs[i];
                    return [proveKind(c.field), {
                        status: p?.status === 'succeeded' ? 'succeeded' : 'failed',
                        ...(p?.txHash ? { txHash: p.txHash, explorerUrl: explorerTxUrl(p.txHash) } : {})
                    }] as [string, Record<string, unknown>];
                }));
            } else {
                await setStep('provePredicate', {
                    status: 'succeeded',
                    txHash: okProofs[0].txHash, explorerUrl: explorerTxUrl(okProofs[0].txHash)
                });
            }

            // 3b. Optional second act: age the battery and repurpose it. Two
            //     simulated telemetry ticks (DB-only, deliberately no tx) and
            //     a status change, which re-anchors the passport as a SECOND
            //     on-chain version through the tester's own session (the
            //     tester is the attester; fees sponsored like everything
            //     else). NEVER fatal: the passport is anchored and proven, a
            //     failed bonus act must not fail the run.
            if (input.secondLife) {
                await this.patchRun(runId, { state: 'aging' });
                await setStep('secondLife', { status: 'running' });
                try {
                    const mocksap: any = await cds.connect.to('BmsSimulatorService');
                    await mocksap.tx({ user }, (tx: any) => tx.send('triggerBmsTelemetry', { passportId, ticks: 2 }));
                    const st: any = await producer.tx({ user }, (tx: any) => tx.send('changeBatteryStatus', {
                        passportId, newStatus: 'repurposed', sessionId
                    }));
                    if (st?.mode !== 'anchoring') throw new Error(`changeBatteryStatus returned mode '${st?.mode}'`);
                    const aged = await this.pollReanchor(passportId);
                    if (aged.status !== 'anchored') throw new Error(`re-anchor ended '${aged.status}'`);
                    await setStep('secondLife', {
                        status: 'succeeded', txHash: aged.attestationTxHash,
                        explorerUrl: explorerTxUrl(aged.attestationTxHash)
                    });
                } catch (e) {
                    log.warn(`run ${runId}: second-life act failed (continuing):`, (e as Error)?.message);
                    await setStep('secondLife', { status: 'failed' });
                }
            }

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
            releaseRemoteSigner(sessionId);
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
                    // Order follows anchorTxPlan (one transaction, lineage 4).
                    const order = ['attest', 'anchorContentRoot', 'bindDocument'];
                    const next = order.find(k => !seen.has(k));
                    if (next) await setStep(next, { status: 'running' });
                }
            }
            if (row?.status === 'anchored' || row?.status === 'failed') return row;
            if (Date.now() > deadline) throw new Error('anchor timed out');
        }
    }

    /**
     * Poll a re-anchoring passport row back to 'anchored'/'failed' (10 min
     * cap). Status only; unlike pollAnchor it mirrors no per-circuit steps,
     * the whole re-anchor is one timeline entry.
     */
    private async pollReanchor(passportId: string): Promise<{ status: string; attestationTxHash?: string }> {
        const deadline = Date.now() + 10 * 60_000;
        for (;;) {
            await new Promise(r => setTimeout(r, 5000));
            const row: any = await SELECT.one.from(Passports)
                .columns('status', 'attestationTxHash').where({ passportId });
            if (row?.status === 'anchored' || row?.status === 'failed') return row;
            if (Date.now() > deadline) throw new Error('re-anchor timed out');
        }
    }

    /** Poll the PredicateProofLog row to completion (10 min cap). */
    private async pollProof(proofLogId: string, timeoutMs = 10 * 60_000): Promise<{ status: string; txHash?: string; sourceField?: string }> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            await new Promise(r => setTimeout(r, 5000));
            const row: any = await SELECT.one.from(PredicateProofLog)
                .columns('status', 'txHash', 'sourceField').where({ ID: proofLogId });
            if (row && row.status !== 'pending') return row;
            if (Date.now() > deadline) throw new Error('proof timed out');
        }
    }

    /** Short root tx for a write, retried on sqlite write contention so a visitor request does not surface a raw 500. */
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

    private async failStaleRuns(): Promise<void> {
        await (cds as any).tx({}, () =>
            UPDATE.entity(Runs)
                .set({ state: 'failed', error: 'server restarted while the run was in flight' })
                .where({ state: { in: ['queued', 'wallet', 'anchoring', 'proving', 'aging', 'publishing'] } }));
    }
}
