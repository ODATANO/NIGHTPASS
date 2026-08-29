import cds from '@sap/cds';
import {
    Passports, Batteries, RecycledMaterials, DiligenceDoc,
    PassportTransactions, DisclosureGrantLog, PredicateProofLog,
    PassportAttributes, PassportAttributeHistory, PassportAnchorVersions
} from '#cds-models/passport';
import {
    hashPayload, blake2b256Hex, encryptPayload, anchorPassport, waitForJob, waitForJobResult,
    detachedFromRequest, sendDetached,
    buildContentRoot, newSaltSeed, decryptPayload, fieldKeyHex, BATTERY_PROVABLE_FIELDS, BATTERY_STRING_FIELDS,
    DYNAMIC_PROVABLE_FIELDS, runChainStep,
    effectiveNetwork, explorerTxUrl
} from './lib/passport-anchor';
import { PluginLane } from './lib/lane-plugin';
import { remoteLaneFor, hasRemoteSigner, remoteVaultFor } from './lib/lane-remote';
import {
    ProofCartError,
    type ChainLane, type CartClaimArgs, type ProofCartInput
} from './lib/chain-lane';
import { CLAIM_SETS, claimSetById } from './lib/claim-sets';
import {
    allowedMaskFor, fieldsFromMask, describeMask, firstUnmaskedDifference, countChangedSlots,
    provableValuesFromPayload, SLOT_COUNT
} from './lib/version-integrity';
import { buildMembershipSet } from './lib/membership-set';
import { defaultGuideAttributes, hashableAttributes } from './lib/guide-attribute-defaults';
import { DYNAMIC_ATTRIBUTES, encodeDynamicValue, decodeDynamicValue, dedupeUpdates, type DynamicUpdate } from './lib/attribute-update';
import { payloadFromDb, readPayloadInputs } from './lib/passport-payload';
import { validateTransition, parseBatteryStatus, encodeBatteryStatus, type BatteryStatus } from './lib/battery-lifecycle';
import { validateDiligenceUpload, decodeUpload, sha256Hex } from './lib/diligence-upload';
import { proofCartPlan, claimKey, responseClaimKey, type ProofClaim } from './lib/proof-plan';
import { listProducerWallets, producerWalletSecrets, feeSponsorWalletId, feeSponsorWalletIds } from './lib/producer-wallets';
import { s4ConfigFromEnv, fetchMaterialDocuments, enrichMaster, loadProductMaster } from './lib/s4-client';
import { buildReceiptRows } from './lib/s4-material-document';
import { verifyContractTx, type ChainVerdict } from './lib/chain-verify';
import { verifyAttestState, attestRootState, verifyGrantState, verifyPredicateState, verifyCrossRootState } from './lib/state-verify';
import { sweepAction, verdictToStatus } from './lib/stuck-rows';

const CONTRACT_REF = 'attestation-vault';

/** One cart claim's log row plus its on-chain coordinates (for per-claim settlement). */
type ProofClaimMeta = {
    proofLogId: string; key: string; fieldKey: string;
    predicate: 'lessOrEqual' | 'greaterOrEqual' | 'setMembership'; threshold?: number; setRoot?: string;
};

const { INSERT, SELECT, UPDATE, DELETE } = cds.ql;

const norm = (h?: string | null): string => String(h ?? '').replace(/^0x/, '');
// Cockpit tx rows happen on the server's CURRENT network, so the explorer link
// derives from it (shared helper; per-row anchorNetwork is used on read paths).
function txExplorerUrl(hash?: string | null): string | null {
    return explorerTxUrl(hash);
}
/** Map a chain verdict to the cockpit-facing row status. */
function walletStatus(v: ChainVerdict): 'succeeded' | 'failed' | 'pending' {
    return v === 'confirmed' ? 'succeeded' : v === 'failed' ? 'failed' : 'pending';
}

/** LargeBinary reads differ per DB adapter: Buffer, base64 string, or stream. */
async function toBuffer(value: unknown): Promise<Buffer | null> {
    if (value == null) return null;
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') return Buffer.from(value, 'base64');
    if (typeof (value as any)[Symbol.asyncIterator] === 'function') {
        const chunks: Buffer[] = [];
        for await (const chunk of value as AsyncIterable<Buffer | string>) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks);
    }
    return null;
}

interface PassportInput {
    passportId: string;
    manufacturerId?: string;
    batteryCategory?: string;
    model?: string;
    manufactureDate?: string;
    weightKg?: number;
    performanceClass?: string;
    batteries?: Record<string, unknown>[];
    recycledMaterials?: Record<string, unknown>[];
    diligenceDocs?: Record<string, unknown>[];
}

/**
 * ProducerService: manufacturer / ERP cockpit write side. See producer-service.cds.
 *
 * Every action is offline-first: it always persists the local row / log, and
 * only touches the chain when a signing session + contract are available. All
 * on-chain legs run DETACHED after the request commits (mode 'anchoring' /
 * 'granting' / 'revoking' / 'proving', else 'offline'); clients poll the row.
 * The anchor sequence is shared with PassportService via srv/lib/passport-anchor.
 */
export default class ProducerService extends cds.ApplicationService {
    /** walletId -> NIGHTGATE signing session (one per configured server wallet). */
    private serverSessions = new Map<string, string>();
    /** sessionId -> pending facade prewarm job; awaited once by the first
     *  detached anchor run on that session (submitting before the facade
     *  exists fails with "No facade for sessionId"). */
    private serverPrewarmJobs = new Map<string, string>();
    /** walletId -> in-flight session creation; dedupes the login prewarm racing
     *  a quick first attest (connectWalletForSigning is rate-limited). */
    private serverSessionInflight = new Map<string, Promise<string | null>>();
    /** walletId -> prewarm bookkeeping for the cockpit status surface. */
    private walletWarmth = new Map<string, { state: 'warming' | 'ready' | 'error'; startedAt: number; error?: string }>();

    override async init(): Promise<void> {
        this.on('createPassport', this.createPassport);
        this.on('submitPassport', this.submitPassport);
        this.on('listServerWallets', this.listServerWallets);
        this.on('s4GoodsReceipts', this.s4GoodsReceipts);
        this.on('prewarmServerWallet', this.prewarmServerWallet);
        this.on('serverWalletStatus', this.serverWalletStatus);
        this.on('serverWalletSession', this.serverWalletSession);
        this.on('sponsorPoolStatus', this.sponsorPoolStatus);
        this.on('recordWalletAttest', this.recordWalletAttest);
        this.on('recordWalletDisclosure', this.recordWalletDisclosure);
        this.on('recordWalletPredicate', this.recordWalletPredicate);
        this.on('recordWalletMembership', this.recordWalletMembership);
        this.on('passportFieldValue', this.passportFieldValue);
        this.on('passportMembershipProof', this.passportMembershipProof);
        this.on('claimSetCatalog', this.claimSetCatalog);
        this.on('validatePassportConformance', this.validatePassportConformance);
        this.on('publishPassport', this.publishPassport);
        this.on('passportAspectJson', this.passportAspectJson);
        this.on('passportCredential', this.passportCredential);
        this.on('grantPassportDisclosure', this.grantPassportDisclosure);
        this.on('revokePassportDisclosure', this.revokePassportDisclosure);
        this.on('provePassportValue', this.provePassportValue);
        this.on('provePassportValuesBatch', this.provePassportValuesBatch);
        this.on('proveVersionIntegrity', this.proveVersionIntegrity);
        this.on('uploadDiligenceDoc', this.uploadDiligenceDoc);
        this.on('diligenceFile', this.diligenceFile);
        this.on('updateDynamicAttributes', this.updateDynamicAttributes);
        this.on('reanchorPassport', this.reanchorPassport);
        this.on('passportDrift', this.passportDrift);
        this.on('changeBatteryStatus', this.changeBatteryStatus);
        this.on('transferPassportOperator', this.transferPassportOperator);
        this.on('claimPassportId', this.claimPassportId);

        // Crash recovery. Every on-chain leg runs detached after the request
        // commits, so a restart in between strands the row in an in-flight
        // state that only the dead process could have moved on. Sweep once
        // after serving starts; best-effort, a failure here must never keep
        // the service from serving.
        cds.once('served', () => {
            void this.sweepStuckRows().catch((e) =>
                cds.log('producer').warn('stuck-row sweep skipped:', (e as Error)?.message));
        });
        return super.init();
    }

    /**
     * Close out on-chain work that a restart interrupted: transaction rows left
     * `pending` and passports left `anchoring`. Rows younger than STUCK_AFTER_MS
     * are left alone (a detached runner may legitimately still be working on a
     * cold wallet). Older rows are re-verified against the chain where possible
     * and otherwise marked failed, because an unconfirmable row must never be
     * reported as succeeded.
     */
    private async sweepStuckRows(): Promise<void> {
        const log = cds.log('producer');
        const now = Date.now();
        const ageOf = (r: any) => now - new Date(String(r.modifiedAt ?? r.createdAt ?? 0)).getTime();

        const txRows: any[] = await SELECT.from(PassportTransactions)
            .columns('ID', 'passport_ID', 'kind', 'txHash', 'modifiedAt', 'createdAt')
            .where({ status: 'pending' });
        let closed = 0;
        for (const row of txRows ?? []) {
            const action = sweepAction({ ageMs: ageOf(row), checkable: !!row.txHash });
            if (action.kind === 'leave') continue;

            let verdict: ChainVerdict = 'unknown';
            if (action.kind === 'recheck') {
                // The passport carries the anchor coordinates; without them the
                // chain cannot be asked and the row stays unconfirmable.
                const p: any = await SELECT.one.from(Passports)
                    .columns('payloadHash', 'contractAddress').where({ ID: row.passport_ID });
                if (p?.contractAddress && p?.payloadHash && row.kind === 'attest') {
                    verdict = await verifyAttestState({ contractAddress: p.contractAddress, payloadHash: p.payloadHash })
                        .catch(() => 'unknown' as ChainVerdict);
                }
            }
            const outcome = action.kind === 'fail'
                ? { status: 'failed' as const, reason: action.reason }
                : verdictToStatus(verdict);
            await UPDATE.entity(PassportTransactions)
                .set({ status: outcome.status, ...(outcome.reason ? { errorMessage: outcome.reason } : {}) } as any)
                .where({ ID: row.ID });
            // The passport follows its attest row: a confirmed attest means the
            // anchor landed after all, anything else leaves a retryable failure.
            if (row.kind === 'attest' && row.passport_ID) {
                await UPDATE.entity(Passports)
                    .set({ status: outcome.status === 'succeeded' ? 'anchored' : 'failed' })
                    .where({ ID: row.passport_ID, status: 'anchoring' });
            }
            closed++;
        }

        // Proof and grant logs have no passport status to follow; they are
        // simply closed out so the cockpit stops showing a spinner forever.
        for (const entity of [PredicateProofLog, DisclosureGrantLog]) {
            const rows: any[] = await SELECT.from(entity)
                .columns('ID', 'modifiedAt', 'createdAt').where({ status: 'pending' });
            for (const row of rows ?? []) {
                if (sweepAction({ ageMs: ageOf(row), checkable: false }).kind === 'leave') continue;
                await UPDATE.entity(entity).set({
                    status: 'failed',
                    errorMessage: 'interrupted by a server restart; retry the operation'
                } as any).where({ ID: row.ID });
                closed++;
            }
        }
        if (closed) log.info(`stuck-row sweep closed ${closed} row(s) left in flight by a restart`);
    }

    // --- session + config ----------------------------------------------------

    private contractAddress(): string | null {
        return process.env.PASSPORT_CONTRACT_ADDRESS ?? null;
    }

    /**
     * The vault a row's chain work targets: the vault leased to a demo run
     * (registered with its remote signer), else the vault an ANCHORED row is
     * bound on (follow-ups must hit that contract), else the instance
     * default. PASSPORT_VAULT_MIGRATE=1 restores env precedence for a
     * deliberate re-anchor onto a new vault (scripts/zz-vault-migrate.mjs).
     */
    private vaultFor(row: { contractAddress?: string | null; status?: string | null } | null, sessionId?: string | null): string | null {
        const leased = remoteVaultFor(sessionId);
        if (leased) return leased;
        if (process.env.PASSPORT_VAULT_MIGRATE !== '1' && row?.status === 'anchored' && row.contractAddress) return row.contractAddress;
        return this.contractAddress() ?? row?.contractAddress ?? null;
    }

    /**
     * Lazy server signing session from env (PRODUCER_VIEWING_KEY + mnemonic/seed).
     *
     * BARE `srv.send()` on purpose: it joins the caller's AMBIENT request tx,
     * so NIGHTGATE's session writes ride on the same sqlite transaction (no
     * cross-tx write-lock conflict) and inherit the request's user, which
     * NIGHTGATE binds the session to. Callers must therefore run inside a
     * proper request context with an authenticated user: HTTP requests have
     * one anyway; programmatic callers (ERP ingest) must use the MANAGED
     * `srv.tx({user}, fn)` form. Both a wrapper `nightgate.tx({user},...)` and
     * `sendDetached` were tried here and deadlock (SQLITE_BUSY) against the
     * caller's open request tx.
     */
    private serverSigningSession(walletId?: string): Promise<string | null> {
        const secrets = producerWalletSecrets(walletId);
        if (!secrets) return Promise.resolve(null);
        const cached = this.serverSessions.get(secrets.id);
        if (cached) return Promise.resolve(cached);
        const inflight = this.serverSessionInflight.get(secrets.id);
        if (inflight) return inflight;
        const opening = this.openServerSession(secrets)
            .finally(() => this.serverSessionInflight.delete(secrets.id));
        this.serverSessionInflight.set(secrets.id, opening);
        return opening;
    }

    private async openServerSession(
        secrets: NonNullable<ReturnType<typeof producerWalletSecrets>>
    ): Promise<string | null> {
        const { mnemonic, viewingKey } = secrets;
        try {
            const nightgate = await cds.connect.to('NightgateService');
            // DETACHED sends: since NIGHTGATE 0.10.2 connectWalletForSigning
            // reads the session row on its own autocommit connection. If
            // connectWallet's INSERT still sits in this request's open tx,
            // that read cannot see it (404 Session not found). Detaching
            // commits the session row before the signing call looks it up.
            // The user must ride along explicitly (sessions are userId-bound
            // and the detached scope drops the ambient context). Callers
            // reached via srv.send() have no ALS context at all, so an absent
            // ambient user falls back to the technical 'producer' principal:
            // every server-wallet session is owned by that principal anyway
            // (cockpit basic auth and the demo executor both resolve to it).
            const ambient = (cds.context as any)?.user;
            const user = ambient?.id ? ambient : new (cds.User as any)({ id: 'producer', roles: ['producer'] });
            const conn: any = await sendDetached(nightgate, 'connectWallet', { viewingKey }, user);
            const sessionId = String(conn.sessionId);
            const signing: any = await sendDetached(nightgate, 'connectWalletForSigning', {
                sessionId, mnemonic
            }, user);
            // Remember the prewarm job: the detached anchor runner must await it
            // before its first submission (the facade does not exist until then).
            if (signing?.prewarmJobId) this.serverPrewarmJobs.set(sessionId, String(signing.prewarmJobId));
            this.walletWarmth.set(secrets.id, {
                state: signing?.prewarmJobId && signing?.prewarmStatus !== 'succeeded' ? 'warming' : 'ready',
                startedAt: Date.now()
            });
            this.serverSessions.set(secrets.id, sessionId);
            return sessionId;
        } catch (e: any) {
            // Log the FULL error shape: CAP OData rejections often carry the
            // detail in e.code/e.reason/e.cause rather than e.message.
            cds.log('producer').warn(`server signing session unavailable (wallet '${secrets.id}'):`,
                e?.message || '(no message)',
                '| code:', e?.code ?? '-',
                '| cause:', e?.cause?.message ?? e?.reason ?? '-',
                '| raw:', (() => { try { return JSON.stringify(e).slice(0, 300); } catch { return String(e); } })());
            this.walletWarmth.set(secrets.id, {
                state: 'error', startedAt: Date.now(), error: String(e?.message ?? e ?? 'session unavailable')
            });
            return null;
        }
    }

    /**
     * Explicit arg session (the in-browser Lace flow supplies one) wins;
     * otherwise open/reuse the session of the selected SERVER wallet. `walletId`
     * selects which configured server wallet signs; omitted = the default one.
     */
    private async effectiveSession(argSessionId?: string, walletId?: string): Promise<string | null> {
        return argSessionId || this.serverSigningSession(walletId);
    }

    /**
     * NIGHTGATE session of the configured fee-sponsor wallet
     * (PASSPORT_FEE_SPONSOR_WALLET), for per-tx dust sponsoring of the
     * on-chain legs. Returns undefined when no sponsor is configured, when the
     * sponsor IS the acting session (self-sponsoring is a no-op), or when the
     * sponsor session cannot be opened. The latter degrades to unsponsored
     * with a warning: a funded acting wallet still succeeds on its own dust,
     * an unfunded one surfaces a clear insufficient-dust failure downstream.
     *
     * Must run inside the original request context (session opening inherits
     * the request's user, and NIGHTGATE's sponsor guard requires the sponsor
     * session to belong to the same user as the acting one).
     */
    private async sponsorSessionIdFor(actingSessionId: string, preferredWalletId?: string): Promise<string | undefined> {
        // The remote lane's sponsor is the hosted pool behind the agent grant.
        if (hasRemoteSigner(actingSessionId)) return undefined;
        const pool = feeSponsorWalletIds();
        if (!pool.length) return undefined;
        // A caller-supplied preference must be a member of the CONFIGURED
        // pool: the param selects among operator-approved sponsors, it can
        // never turn an arbitrary registry wallet into one.
        const sponsorWallet = preferredWalletId && pool.includes(preferredWalletId)
            ? preferredWalletId
            : pool[0];
        const sponsorSession = await this.serverSigningSession(sponsorWallet);
        if (!sponsorSession) {
            cds.log('producer').warn(
                `fee sponsor wallet '${sponsorWallet}' has no signing session; proceeding UNSPONSORED`);
            return undefined;
        }
        if (sponsorSession === actingSessionId) return undefined;
        return sponsorSession;
    }

    /** The configured server wallets the cockpit can sign with (no secrets). */
    private listServerWallets = async () => {
        return listProducerWallets();
    };

    // Enriched S/4 product master, cached briefly: the enrichment is two HTTP
    // calls per material and master data changes rarely.
    private s4MasterCache: { at: number; master: import('./lib/s4-material-document').ProductMaster } | null = null;

    /** Live goods-receipt list from the configured S/4 system (see .cds doc). */
    private s4GoodsReceipts = async (req: cds.Request) => {
        const cfg = s4ConfigFromEnv();
        if (!cfg) {
            return req.reject(503, 'no S/4 system configured (set S4_BASE_URL plus S4_API_KEY or S4_USER/S4_PASSWORD)');
        }
        try {
            if (!this.s4MasterCache || Date.now() - this.s4MasterCache.at > 300_000) {
                this.s4MasterCache = { at: Date.now(), master: await enrichMaster(cfg, loadProductMaster(cfg)) };
            }
            const headers = await fetchMaterialDocuments(cfg);
            const rows = buildReceiptRows(headers, this.s4MasterCache.master, new Set(), cfg.movementTypes);
            const ids = rows.map(r => r.passportId);
            const existing: any[] = ids.length
                ? await SELECT.from('passport.Passports').columns('passportId').where({ passportId: { in: ids } })
                : [];
            const existingIds = new Set(existing.map(r => String(r.passportId)));
            return rows.map(r => (r.status === 'ready' && existingIds.has(r.passportId)) ? { ...r, status: 'exists' } : r);
        } catch (e: any) {
            const msg = String(e?.message ?? e);
            return req.reject(502, msg.startsWith('S/4') ? msg : `S/4 read failed: ${msg}`);
        }
    };

    /**
     * Kick off the signing-facade prewarm for a server wallet (cockpit login).
     * Opening the session already starts the prewarm inside NIGHTGATE; the call
     * returns as soon as the session exists, NOT when the wallet is synced.
     */
    private prewarmServerWallet = async (req: cds.Request) => {
        const { walletId } = req.data as { walletId?: string };
        const secrets = producerWalletSecrets(walletId);
        if (!secrets) return req.reject(404, `unknown server wallet '${walletId ?? ''}'`);
        const sessionId = await this.serverSigningSession(secrets.id);
        if (!sessionId) {
            const w = this.walletWarmth.get(secrets.id);
            return { walletId: secrets.id, state: 'error', error: w?.error || 'signing session unavailable (see server log)' };
        }
        const w = this.walletWarmth.get(secrets.id);
        return { walletId: secrets.id, state: w?.state ?? 'ready', error: w?.error ?? '' };
    };

    /**
     * Warmth of a server wallet's facade for the cockpit header status. While
     * 'warming', each call polls the prewarm job once; 'ready' means the wallet
     * is synced to the chain tip. Never rejects on job-read hiccups; it just
     * reports the last known state.
     */
    /**
     * The (cached, or newly opened) NIGHTGATE session of a server wallet.
     * Exists so in-process consumers (demo executor's registrar step) reuse
     * the ONE session per wallet instead of connecting a second facade for
     * the same accountId, which wedges the wallet worker.
     */
    private serverWalletSession = async (req: cds.Request) => {
        const { walletId } = req.data as { walletId?: string };
        const secrets = producerWalletSecrets(walletId);
        if (!secrets) return req.reject(404, `unknown server wallet '${walletId ?? ''}'`);
        const sessionId = await this.serverSigningSession(secrets.id);
        if (!sessionId) return req.reject(503, `server wallet '${secrets.id}' has no signing session`);
        return { sessionId };
    };

    private serverWalletStatus = async (req: cds.Request) => {
        const { walletId } = req.data as { walletId?: string };
        const secrets = producerWalletSecrets(walletId);
        if (!secrets) return req.reject(404, `unknown server wallet '${walletId ?? ''}'`);
        const sessionId = this.serverSessions.get(secrets.id);
        const warmth = this.walletWarmth.get(secrets.id);
        if (!sessionId) {
            // No session yet: either never prewarmed ('cold') or opening failed.
            const state = warmth?.state === 'error' ? 'error' : 'cold';
            return { walletId: secrets.id, state, sinceSeconds: 0, error: warmth?.error ?? '' };
        }
        let state: string = warmth?.state ?? 'ready';
        let error = warmth?.error ?? '';
        if (state === 'warming') {
            const jobId = this.serverPrewarmJobs.get(sessionId);
            if (!jobId) {
                state = 'ready';
            } else {
                try {
                    const nightgate = await cds.connect.to('NightgateService');
                    const job: any = await sendDetached(nightgate, 'getJobStatus', { jobId, sessionId }, req.user);
                    if (job?.status === 'succeeded') state = 'ready';
                    else if (job?.status === 'failed') {
                        const failMsg = `${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim() || 'prewarm failed';
                        if (/SUPERSEDED/i.test(failMsg)) {
                            // 0.10.2: a fresh prewarm superseded this one; the
                            // successor carries the sync, so keep 'warming'.
                            state = 'warming';
                            this.serverPrewarmJobs.delete(sessionId);
                        } else {
                            state = 'error';
                            error = failMsg;
                        }
                    } else if (job?.status === 'reconciliation_required') {
                        state = 'error';
                        error = `${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim() || 'prewarm requires reconciliation';
                    }
                } catch { /* job read hiccup: keep reporting 'warming' */ }
            }
            if (warmth && state !== 'warming') {
                this.walletWarmth.set(secrets.id, { ...warmth, state: state as 'ready' | 'error', error });
            }
            // The prewarm job entry stays in serverPrewarmJobs on purpose: the
            // first anchor run still awaits it (a completed job resolves instantly).
        }
        const sinceSeconds = warmth ? Math.round((Date.now() - warmth.startedAt) / 1000) : 0;
        return { walletId: secrets.id, state, sinceSeconds, error };
    };

    /**
     * Dust monitor for the fee-sponsor pool. For each configured sponsor whose
     * signing session is already open (the boot prewarm opens them), read its
     * NIGHT + dust balance via NIGHTGATE. A cold/errored sponsor reports its
     * state without a balance read, so this stays a cheap, non-blocking call
     * (it never opens a session). Runs the balance reads under the caller's
     * user, which for the demo path is the same technical principal that opened
     * the sponsor sessions (NIGHTGATE binds sessions to the userId).
     */
    /**
     * Whether the prewarm job recorded for this session is still pending or
     * running. Used to tell "facade not built YET" (serial prewarm queue,
     * NIGHTGATE >= 0.13.0) apart from a genuinely dead session. Unknown job
     * or read failure counts as not running, which falls through to the
     * self-heal path.
     */
    private async prewarmStillRunning(nightgate: cds.Service, sessionId: string, user: unknown): Promise<boolean> {
        const jobId = this.serverPrewarmJobs.get(sessionId);
        if (!jobId) return false;
        try {
            const j: any = await sendDetached(nightgate, 'getJobStatus', { jobId }, user);
            const s = String(j?.status ?? '');
            return s === 'pending' || s === 'running';
        } catch {
            return false;
        }
    }

    private sponsorPoolStatus = async (req: cds.Request) => {
        const pool = feeSponsorWalletIds();
        if (!pool.length) return [];
        const labels = listProducerWallets();
        const nightgate = await cds.connect.to('NightgateService');
        const night = (atoms: unknown): string => {
            try { return (Number(BigInt(String(atoms ?? 0))) / 1e6).toLocaleString('en-US'); }
            catch { return ''; }
        };
        const cold = (walletId: string, label: string, state: string, error = '') => ({
            walletId, label, state, nightDisplay: '', dustPresent: false,
            registeredNightUtxos: 0, healthy: false, error
        });
        const out: unknown[] = [];
        for (const walletId of pool) {
            const secrets = producerWalletSecrets(walletId);
            const label = labels.find((w) => w.id === walletId)?.label ?? walletId;
            if (!secrets) { out.push(cold(walletId, label, 'error', 'not configured')); continue; }
            const sessionId = this.serverSessions.get(secrets.id);
            const warmth = this.walletWarmth.get(secrets.id);
            if (!sessionId) {
                out.push(cold(secrets.id, label, warmth?.state === 'error' ? 'error' : 'cold', warmth?.error ?? ''));
                continue;
            }
            try {
                // NIGHTGATE >= 0.10.2: this read holds no request tx server-side
                // and is bounded (NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS, default
                // 10s) - a still-syncing facade answers 503 WALLET_SYNCING
                // instead of blocking, so this poll is always cheap.
                const b: any = await sendDetached(nightgate, 'getWalletBalance', { sessionId }, req.user);
                const registered = Number(b?.registeredNightUtxoCount ?? 0);
                const dustPresent = Number(b?.dustBalance ?? 0) > 0;
                // A successful balance read means the facade is live and serving
                // this wallet's state, i.e. operational. The warmth 'warming'
                // flag only flips to 'ready' when something polls
                // serverWalletStatus, which nothing does for sponsors, so it
                // would stay 'warming' forever; health keys off the real fee
                // signals instead (spendable dust + registered NIGHT UTxOs).
                out.push({
                    walletId: secrets.id, label, state: 'ready',
                    nightDisplay: night(b?.unshieldedNight),
                    dustPresent, registeredNightUtxos: registered,
                    healthy: registered > 0 && dustPresent,
                    error: ''
                });
            } catch (e: any) {
                const msg = String(e?.message ?? e ?? 'balance read failed');
                // 503 WALLET_SYNCING = retryable per the 0.10.2 contract; a
                // SUPERSEDED prewarm just means a fresh one took over.
                if (/WALLET_SYNCING|SUPERSEDED/i.test(msg)) {
                    out.push(cold(secrets.id, label, 'warming', ''));
                } else if (/No facade/i.test(msg) && await this.prewarmStillRunning(nightgate, sessionId, req.user)) {
                    // NIGHTGATE >= 0.13.0 warms wallets ONE at a time, so a
                    // freshly opened session has no facade until its queued
                    // prewarm job actually runs. That is warming, not death;
                    // reconnecting here would just requeue another prewarm.
                    out.push(cold(secrets.id, label, 'warming', ''));
                } else if (/No facade|Session not found|Session expired/i.test(msg)) {
                    // SELF-HEAL, two known death modes of a cached session:
                    // "No facade": NIGHTGATE's session-expiry sweep evicts
                    // facades by accountId, so an expiring STALE session of
                    // this wallet (from an earlier boot) takes the live facade
                    // down with it. "Session not found or inactive": the
                    // cached session ROW itself hit its TTL and the cleanup
                    // removed it (long container uptime, seen live 2026-08-01).
                    // Either way: drop the cached session and reconnect; the
                    // fresh connectWalletForSigning restores facade + prewarm.
                    cds.log('producer').warn(
                        `sponsor '${secrets.id}' session dead (${msg.slice(0, 80)}); reconnecting`);
                    this.serverSessions.delete(secrets.id);
                    void this.serverSigningSession(secrets.id).catch(() => { /* logged inside */ });
                    out.push(cold(secrets.id, label, 'warming', ''));
                } else {
                    out.push(cold(secrets.id, label, 'error', msg));
                }
            }
        }
        return out;
    };

    /**
     * Whether this passport's content root is already anchored on-chain.
     * Two row shapes count: an explicit succeeded 'anchorContentRoot' tx
     * (server anchor path records one), or a succeeded wallet 'attest' row.
     * The wallet batch anchors the root in the SAME tx as the attest and
     * records only the attest row, so requiring an anchorContentRoot row
     * made the server re-send the root for wallet-anchored passports, and
     * the vault rejects that with "failed assert: not attester" (only the
     * original attester may anchor the root; found live 2026-08-02).
     * Residual edge: an ancient sequential wallet attest without a root
     * makes proofs fail honestly with "no content root".
     */
    private async contentRootAnchored(passportRowId: string): Promise<boolean> {
        const hit = await SELECT.one.from(PassportTransactions).columns('ID')
            .where({ passport_ID: passportRowId, kind: { in: ['anchorContentRoot', 'attest'] }, status: 'succeeded' });
        return !!hit;
    }

    private async passportRef(passportId: string) {
        return SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'payloadHash', 'passportIdHash', 'contractAddress', 'status')
            .where({ passportId });
    }

    /**
     * Provable-field → raw-value map for a passport, read from its (first)
     * battery. Feeds `buildContentRoot` so the on-chain content root and the
     * inclusion proofs are built from the passport's ACTUAL field values.
     * (Demo assumption: one provable battery per passport.)
     */
    private async fieldValuesFor(passportRowId: string): Promise<Record<string, number | string>> {
        const out: Record<string, number | string> = {};
        // Battery scalar + string fields (actual Batteries columns).
        const bat: any = await SELECT.one.from(Batteries)
            .columns(...(BATTERY_PROVABLE_FIELDS as readonly string[]), ...(BATTERY_STRING_FIELDS as readonly string[]))
            .where({ passport_ID: passportRowId });
        for (const f of BATTERY_PROVABLE_FIELDS) if (bat?.[f] != null) out[f] = bat[f];
        for (const f of BATTERY_STRING_FIELDS) if (bat?.[f] != null && bat[f] !== '') out[f] = String(bat[f]);
        // Per-material recycled content (RecycledMaterials rows) → recycled<Material>Pct.
        const recs: any[] = await SELECT.from(RecycledMaterials)
            .columns('material', 'recycledPercentage')
            .where({ passport_ID: passportRowId });
        for (const r of recs || []) {
            if (r?.material && r.recycledPercentage != null) out[`recycled${r.material}Pct`] = r.recycledPercentage;
        }
        // Dynamic (measured) slots come from the guide attribute rows, decoded
        // back to their scalar. Absent attributes simply leave their slot
        // absent; a category that does not carry them (e.g. a battery without
        // a BMS) is not a special case here.
        const dyn: any[] = await SELECT.from(PassportAttributes)
            .columns('attribute', 'valueJson')
            .where({ passport_ID: passportRowId, attribute: { in: [...DYNAMIC_PROVABLE_FIELDS] } });
        for (const a of dyn || []) {
            const n = decodeDynamicValue(String(a?.attribute), a?.valueJson);
            if (n != null) out[String(a.attribute)] = n;
        }
        return out;
    }

    /**
     * The persisted salt seed of a passport's ANCHORED content tree, read from
     * the base entity: both service projections exclude the column on purpose
     * (it is witness material), so `passportRef` can never carry it.
     *
     * Null for rows anchored before 0.16.0 or never anchored at all. A null
     * seed on an ANCHORED row means the tree is unreproducible and every claim
     * would abort at local proving; callers surface that as "re-anchor first"
     * rather than burning minutes of proving.
     */
    private async contentSaltSeedOf(passportRowId: string): Promise<string | null> {
        const row: any = await SELECT.one.from('passport.Passports')
            .columns('contentSaltSeed').where({ ID: passportRowId });
        const seed = String(row?.contentSaltSeed ?? '');
        return /^[0-9a-f]{64}$/i.test(seed) ? seed.toLowerCase() : null;
    }

    /**
     * Rebuild a passport's content tree the way it was ANCHORED: same field
     * values, same salt seed. The single entry point for every proof path.
     *
     * Since NIGHTGATE 0.16.0 the leaves are salted, so "rebuild the tree" is no
     * longer a pure function of the values: without the anchored seed the root
     * differs and every claim fails at local proving. A missing seed therefore
     * yields a tree built from a FRESH seed, which is correct only for a
     * passport that has not been anchored yet (create path); anchored rows are
     * gated by the caller via `contentSaltSeedOf`.
     */
    private async contentTreeFor(passportRowId: string, values?: Record<string, number | string>) {
        const vals = values ?? await this.fieldValuesFor(passportRowId);
        const stored = await this.contentSaltSeedOf(passportRowId);
        const tree = await buildContentRoot(vals, { saltSeed: stored });
        // Lazy materialisation: a passport without a seed gets one on FIRST use
        // and keeps it. Without this, every caller would build a tree under a
        // fresh random seed, and the browser wallet lane (which anchors a root
        // it read from a plain function response) would anchor a root whose
        // opening never existed anywhere but in that one response. The seed is
        // independent of the field values, so fixing it early costs nothing;
        // a re-anchor deliberately rotates it (see anchorRow).
        if (!stored) await this.persistContentTree(passportRowId, tree);
        // `saltSeed` reports what was STORED before this call: callers use it to
        // tell "anchored under a seed we still have" from "anchored before the
        // salted-leaf release", which a freshly materialised seed would mask.
        return { values: vals, saltSeed: stored, tree };
    }

    /**
     * Persist the coordinates of a content tree that is ABOUT TO BE anchored.
     * Always before the submission, never after: a seed that reached the chain
     * but not the database leaves an anchored root nobody can rebuild.
     */
    private async persistContentTree(passportRowId: string, tree: { contentRoot: string; schemaId: string; saltSeed: string }) {
        await UPDATE.entity('passport.Passports').set({
            contentRoot: tree.contentRoot,
            contentSchemaId: tree.schemaId,
            contentSaltSeed: tree.saltSeed
        } as any).where({ ID: passportRowId });
    }

    // --- create + submit -----------------------------------------------------

    private createPassport = async (req: cds.Request) => {
        const { passportJson, submit, sessionId, owner, walletId, sponsorWalletId } = req.data as
            { passportJson?: string; submit?: boolean; sessionId?: string; owner?: string; walletId?: string; sponsorWalletId?: string };

        let input: PassportInput;
        try { input = JSON.parse(String(passportJson ?? '')); }
        catch { return req.reject(400, 'passportJson must be valid JSON'); }

        const passportId = String(input.passportId ?? '').trim();
        if (!passportId) return req.reject(400, 'passportId is required');
        if (await SELECT.one.from(Passports).columns('ID').where({ passportId })) {
            return req.reject(409, `passport '${passportId}' already exists`);
        }

        // Private Annex XIII content (Points 2-4). Hashed + encrypted; never public.
        const batteries = input.batteries ?? [];
        const recycledMaterials = input.recycledMaterials ?? [];
        const diligenceDocs = input.diligenceDocs ?? [];
        // Guide-format attributes (DIN DKE SPEC 99100 longlist): caller rows or
        // the default set; part of the anchored payload, canonically sorted.
        const attributes = (input as any).attributes?.length
            ? hashableAttributes((input as any).attributes)
            : hashableAttributes(defaultGuideAttributes({
                passportId, model: input.model, performanceClass: input.performanceClass,
                batteryCategory: input.batteryCategory,
            }));
        // Hash the v2 projection (payloadFromDb) over EXACTLY the rows the
        // insert below persists, so the drift check's recompute reproduces
        // this hash from the DB. Hashing the raw input objects (v1) made
        // every fresh anchor report drift until its first re-anchor. Only
        // docType survives the create insert for diligence docs (evidence
        // uploads come later), so only docType may enter the hash.
        const { canonicalPayload, payloadHash } = hashPayload(payloadFromDb({
            batteries: batteries as unknown as Record<string, unknown>[],
            recycledMaterials: recycledMaterials as unknown as Record<string, unknown>[],
            diligenceDocs: diligenceDocs.map((d) => ({ docType: d.docType })),
            attributes
        }));
        const passportIdHash = blake2b256Hex(passportId);
        const payloadCipher = encryptPayload(canonicalPayload, passportId);

        const demoHost = process.env.PASSPORT_DEMO_HOST ?? 'https://passport.example';
        const contractAddress = this.vaultFor(null, sessionId);
        const ID = cds.utils.uuid();

        await INSERT.into(Passports).entries({
            ID,
            passportId,
            owner: owner || null,
            manufacturerId: input.manufacturerId,
            batteryCategory: input.batteryCategory as any,
            model: input.model,
            manufactureDate: input.manufactureDate as any,
            weightKg: input.weightKg,
            performanceClass: input.performanceClass,
            qrCodeUrl: `${demoHost}/p/${passportId}`,
            payloadCipher: payloadCipher as any,
            payloadHash,
            passportIdHash,
            contractAddress,
            anchorNetwork: contractAddress ? effectiveNetwork() : null,
            status: 'draft',
            batteries: batteries.map((b) => ({ ...b })),
            recycledMaterials: recycledMaterials.map((m) => ({ ...m })),
            diligenceDocs: diligenceDocs.map((d) => ({ docType: d.docType })),
            attributes: attributes.map((a) => ({ ...a }))
        } as any);

        const session = submit ? await this.effectiveSession(sessionId, walletId) : null;
        if (submit && session && contractAddress) {
            return this.anchorRow(req, ID, passportId, payloadHash, passportIdHash, contractAddress, session, true, sponsorWalletId);
        }
        // Offline: record a placeholder tx row so the overview shows the draft.
        // No on-chain anchor here, so there is no content root to report.
        await INSERT.into(PassportTransactions).entries({ passport_ID: ID, kind: 'attest', status: 'offline' } as any);
        return { passportId, payloadHash, contentRoot: '', mode: 'offline', txHash: '' };
    };

    private submitPassport = async (req: cds.Request) => {
        const { passportId, sessionId, walletId, sponsorWalletId } = req.data as
            { passportId?: string; sessionId?: string; walletId?: string; sponsorWalletId?: string };
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const contractAddress = this.vaultFor(row, sessionId);
        const session = await this.effectiveSession(sessionId, walletId);
        if (!session || !contractAddress) {
            return req.reject(400, 'no signing session / PASSPORT_CONTRACT_ADDRESS available; cannot submit on-chain');
        }
        const r = await this.anchorRow(req, row.ID, row.passportId, row.payloadHash, row.passportIdHash, contractAddress, session, false, sponsorWalletId);
        return { passportId: r.passportId, contentRoot: r.contentRoot ?? '', mode: r.mode, txHash: r.txHash };
    };

    /**
     * Persist a wallet-driven (in-app Lace) attest tx into the cockpit.
     *
     * The browser hands us a txHash after it submits. That is a CLAIM, not proof:
     * the row lands `pending` and the passport `anchoring`. It is only marked
     * `anchored` once the tx is structurally verified on-chain (found, SUCCESS,
     * and acting on the AttestationVault). See settleWalletTx / verifyContractTx.
     */
    private recordWalletAttest = async (req: cds.Request) => {
        const { passportId, txHash, identifier, contractAddress } = req.data as
            { passportId?: string; txHash?: string; identifier?: string; contractAddress?: string };
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const hash = norm(txHash);
        const contract = contractAddress || row.contractAddress || this.contractAddress();
        const txRowId = cds.utils.uuid();
        // Drop the draft placeholder ('attest'/'offline'); the real wallet attest
        // row replaces it.
        await DELETE.from(PassportTransactions).where({ passport_ID: row.ID, kind: 'attest', status: 'offline' });
        await INSERT.into(PassportTransactions).entries({
            ID: txRowId, passport_ID: row.ID, kind: 'attest', txHash: hash || null, identifier: identifier || null,
            status: 'pending', explorerUrl: hash ? txExplorerUrl(hash) : null
        } as any);
        await UPDATE.entity(Passports).set({
            status: 'anchoring',
            attestationTxHash: hash || row.attestationTxHash,
            contractAddress: contract || row.contractAddress
        }).where({ ID: row.ID });

        const verdict = await this.settleWalletTx({
            txHash: hash, contractAddress: contract,
            // Crawler-free: confirm the payload hash is anchored in the vault.
            stateCheck: () => verifyAttestState({ contractAddress: contract, payloadHash: row.payloadHash }),
            onConfirmed: async () => {
                await UPDATE.entity(PassportTransactions).set({ status: 'succeeded' }).where({ ID: txRowId });
                await UPDATE.entity(Passports).set({ status: 'anchored' }).where({ ID: row.ID });
            },
            onFailed: async () => {
                await UPDATE.entity(PassportTransactions).set({ status: 'failed', errorMessage: 'tx not verified on-chain' }).where({ ID: txRowId });
                await UPDATE.entity(Passports).set({ status: 'failed' }).where({ ID: row.ID });
            }
        });
        return { ok: verdict !== 'failed', txHash: hash, status: walletStatus(verdict) };
    };

    /**
     * Persist a wallet-driven (in-app Lace) disclosure grant/revoke.
     *
     * Held at `pending` until the tx is verified on-chain, so an unverified
     * grant never elevates a partner's read tier (the read gate counts only
     * succeeded/offline grants, not pending ones).
     */
    private recordWalletDisclosure = async (req: cds.Request) => {
        const { passportId, grantee, level, op, txHash } = req.data as
            { passportId?: string; grantee?: string; level?: number; op?: string; txHash?: string };
        if (!grantee) return req.reject(400, 'grantee is required');
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const o = op === 'revoke' ? 'revoke' : 'grant';
        const hash = norm(txHash);
        const contract = row.contractAddress || this.contractAddress();
        const grantLogId = cds.utils.uuid();
        const txRowId = cds.utils.uuid();
        await INSERT.into(DisclosureGrantLog).entries({
            ID: grantLogId, passport_ID: row.ID, grantee, level: Number(level ?? 0), op: o, txHash: hash || null, status: 'pending'
        } as any);
        await INSERT.into(PassportTransactions).entries({
            ID: txRowId, passport_ID: row.ID, kind: o === 'grant' ? 'grantDisclosure' : 'revokeDisclosure',
            txHash: hash || null, status: 'pending', explorerUrl: hash ? txExplorerUrl(hash) : null
        } as any);

        const verdict = await this.settleWalletTx({
            txHash: hash, contractAddress: contract,
            // Crawler-free: reindex the on-chain disclosures ACL, then confirm this
            // grant/revoke is reflected for (contract, payloadHash, grantee).
            stateCheck: () => verifyGrantState({ contractAddress: contract, payloadHash: row.payloadHash, grantee, op: o }),
            onConfirmed: async () => {
                await UPDATE.entity(DisclosureGrantLog).set({ status: 'succeeded' }).where({ ID: grantLogId });
                await UPDATE.entity(PassportTransactions).set({ status: 'succeeded' }).where({ ID: txRowId });
            },
            onFailed: async () => {
                await UPDATE.entity(DisclosureGrantLog).set({ status: 'failed' }).where({ ID: grantLogId });
                await UPDATE.entity(PassportTransactions).set({ status: 'failed', errorMessage: 'tx not verified on-chain' }).where({ ID: txRowId });
            }
        });
        return { ok: verdict !== 'failed', txHash: hash, status: walletStatus(verdict) };
    };

    /**
     * Read a passport battery field value AND its field-bound inclusion proof,
     * for the in-app Lace predicate flow. Returns the raw value (display), the
     * scaled Uint<64> value (witness), the canonical fieldKey, the content root
     * (to anchor), and the Merkle path (siblings/dirs as JSON): everything the
     * connector's anchorContentRoot + proveFieldPredicate need. The value stays
     * client-side; nothing here is a circuit arg.
     */
    private passportFieldValue = async (req: cds.Request) => {
        const { passportId, sourceField } = req.data as { passportId?: string; sourceField?: string };
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const field = sourceField || 'carbonFootprintKgCO2';
        const values = await this.fieldValuesFor(row.ID);
        const v = values[field];
        const base = {
            value: v == null ? '' : String(v), scaledValue: '', found: v != null,
            fieldKey: fieldKeyHex(field), contentRoot: '', schemaId: '', fieldSalt: '',
            siblingsJson: '[]', dirsJson: '[]', rootDrift: false
        };
        if (v == null) return base;

        // Build the content root + inclusion proof from the passport's provable
        // fields, with the ANCHORED salt seed. Degrade gracefully (value still
        // returned for display) if the plugin's pure circuits aren't available.
        try {
            const { tree } = await this.contentTreeFor(row.ID, values);
            const proof = tree.proofFor(field);
            base.contentRoot = tree.contentRoot;
            base.schemaId = tree.schemaId;
            // Numeric fields only: string fields travel through
            // passportMembershipProof (digest, set path), never as a scaled value.
            if (proof?.kind === 'numeric') {
                base.scaledValue = proof.value;
                base.fieldSalt = proof.salt;
                base.siblingsJson = JSON.stringify(proof.siblings);
                base.dirsJson = JSON.stringify(proof.dirs);
            }
            // Drift warning for the wallet lane: proofs under a rebuilt tree
            // whose root differs from the ANCHORED one fail every claim at
            // local proving (minutes of wasted proving plus an opaque abort).
            // Additive return field; deployed callers ignore it.
            if (await this.contentRootAnchored(row.ID)) {
                const verdict = await attestRootState({
                    contractAddress: this.vaultFor(row),
                    payloadHash: row.payloadHash, contentRoot: tree.contentRoot, schemaId: tree.schemaId
                });
                base.rootDrift = verdict === 'mismatch';
            }
        } catch (e) {
            cds.log('producer').warn('content-root/proof build skipped:', (e as Error)?.message);
        }
        return base;
    };

    /**
     * Everything the browser wallet lane needs for ONE membership claim:
     * the content-root inclusion proof of the string field (digest form, the
     * raw value never leaves the server response), the canonical set root of
     * the named allow-list, and the depth-6 set inclusion path. `member:false`
     * lets the cockpit refuse honestly BEFORE any wallet popup; `rootDrift`
     * warns when the anchored root predates the current provable-field layout
     * (every claim would fail at local proving until a re-anchor).
     */
    private passportMembershipProof = async (req: cds.Request) => {
        const { passportId, sourceField, setId } = req.data as
            { passportId?: string; sourceField?: string; setId?: string };
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const field = String(sourceField ?? '');
        const set = claimSetById(String(setId ?? ''));
        if (!set) return req.reject(400, `unknown claim set '${setId}'`);
        if (set.sourceField !== field) {
            return req.reject(400, `claim set '${set.id}' applies to '${set.sourceField}', not '${field}'`);
        }
        const values = await this.fieldValuesFor(row.ID);
        const v = values[field];
        const base = {
            found: v != null, member: false, rootDrift: false,
            fieldKey: fieldKeyHex(field), fieldDigest: '', contentRoot: '',
            schemaId: '', fieldSalt: '',
            siblingsJson: '[]', dirsJson: '[]',
            setId: set.id, setLabel: set.label, setRoot: '', memberCount: 0,
            setSiblingsJson: '[]', setDirsJson: '[]'
        };
        if (v == null) return base;

        const memberSet = await buildMembershipSet(set.values);
        base.setRoot = memberSet.setRoot;
        base.memberCount = memberSet.memberCount;
        const setProof = memberSet.proofFor(String(v));
        if (!setProof) return base; // member stays false; UI refuses pre-wallet
        base.member = true;
        base.setSiblingsJson = JSON.stringify(setProof.setSiblings);
        base.setDirsJson = JSON.stringify(setProof.setDirs);

        const { tree } = await this.contentTreeFor(row.ID, values);
        const proof = tree.proofFor(field);
        base.contentRoot = tree.contentRoot;
        base.schemaId = tree.schemaId;
        if (proof?.kind === 'string') {
            base.fieldDigest = proof.valueDigest;
            base.fieldSalt = proof.salt;
            base.siblingsJson = JSON.stringify(proof.siblings);
            base.dirsJson = JSON.stringify(proof.dirs);
        } else {
            return req.reject(400, `field '${field}' is not a string provable field`);
        }
        // Drift check only when a root is anchored; 'unknown' (unreachable
        // indexer) keeps rootDrift=false and the circuit aborts honestly.
        if (await this.contentRootAnchored(row.ID)) {
            const contractAddress = this.vaultFor(row);
            const verdict = await attestRootState({
                contractAddress, payloadHash: row.payloadHash, contentRoot: tree.contentRoot, schemaId: tree.schemaId
            });
            base.rootDrift = verdict === 'mismatch';
        }
        return base;
    };

    /** The named allow-list catalog for the cockpit picker (values included:
     *  they are public by design; verifiers recompute the root from them). */
    private claimSetCatalog = async () => {
        return {
            setsJson: JSON.stringify(CLAIM_SETS.map((s) => ({
                id: s.id, label: s.label, sourceField: s.sourceField,
                memberCount: s.values.length, values: s.values
            })))
        };
    };

    /** Official BatteryPass-Ready conformance check (server-proxied, key hidden). */
    private validatePassportConformance = async (req: cds.Request) => {
        const { passportId } = req.data as { passportId?: string };
        const p: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'model', 'manufacturerId', 'batteryCategory',
                'manufactureDate', 'weightKg', 'performanceClass', 'modifiedAt', 'status')
            .where({ passportId });
        if (!p) return req.reject(404, `passport '${passportId}' not found`);
        const batteries: any[] = await SELECT.from(Batteries)
            .columns('serialNumber', 'cellChemistry', 'capacityKwh', 'carbonFootprintKgCO2',
                'cycleLife', 'roundTripEfficiencyPct').where({ passport_ID: p.ID });
        const recycled: any[] = await SELECT.from(RecycledMaterials)
            .columns('material', 'recycledPercentage').where({ passport_ID: p.ID });
        const attrs: any[] = await SELECT.from('passport.PassportAttributes')
            .columns('section', 'attribute', 'valueJson').where({ passport_ID: p.ID });
        const { validateConformance } = require('./lib/bp-ready-validate');
        const r = await validateConformance(p, batteries, recycled, attrs);
        return { ...r, error: r.error ?? '' };
    };

    /** Push an anchored passport's public fields to the public explorer instance. */
    private publishPassport = async (req: cds.Request) => {
        const { passportId } = req.data as { passportId?: string };
        const url = process.env.PASSPORT_PUBLISH_URL;
        const secret = process.env.PASSPORT_PUBLISH_SECRET;
        if (!url || !secret) return req.reject(503, 'publishing not configured (PASSPORT_PUBLISH_URL / PASSPORT_PUBLISH_SECRET)');
        const p: any = await SELECT.one.from(Passports)
            .columns('passportId', 'model', 'manufacturerId', 'batteryCategory', 'manufactureDate',
                'weightKg', 'performanceClass', 'qrCodeUrl', 'payloadHash', 'contractAddress',
                'anchorNetwork', 'attestationTxHash', 'status')
            .where({ passportId });
        if (!p) return req.reject(404, `passport '${passportId}' not found`);
        if (p.status !== 'anchored') return req.reject(400, `passport '${passportId}' is not anchored (status: ${p.status})`);
        // Proven ZK claims travel with the public fields (claim + threshold +
        // proof tx are public by design; the underlying value never leaves).
        const rowId: any = await SELECT.one.from(Passports).columns('ID').where({ passportId });
        const proofs: any[] = await SELECT.from(PredicateProofLog)
            .columns('sourceField', 'predicate', 'threshold', 'unit', 'txHash', 'createdAt', 'payloadHash', 'setRoot', 'setId')
            .where({ passport_ID: rowId.ID, status: 'succeeded', result: true })
            .orderBy('createdAt');
        const claims = proofs.map((c) => {
            const common = {
                sourceField: c.sourceField, predicate: c.predicate,
                txHash: c.txHash ?? '', provenAt: c.createdAt ?? null,
                // The version hash the claim was proven under, so the public
                // instance verifies against the right version directly instead
                // of probing the anchor history.
                payloadHash: c.payloadHash ?? null,
            };
            if (c.predicate === 'setMembership') {
                // The allow-list travels with the claim: it is public by
                // design, and publishing the values lets ANY verifier
                // recompute the set root from the list alone.
                const set = claimSetById(c.setId ?? '');
                return {
                    ...common, setRoot: c.setRoot ?? '', setId: c.setId ?? '',
                    setLabel: set?.label ?? c.setId ?? '', allowedValues: set?.values ?? null,
                };
            }
            return { ...common, threshold: Number(c.threshold) / 1000, unit: c.unit ?? '' };
        });
        // Superseded anchor versions travel too (public anchor metadata only,
        // never the archived payloadCipher), so the public explorer can show
        // the anchor history and live-verify each version.
        const versionRows: any[] = await SELECT.from(PassportAnchorVersions)
            .columns('version', 'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'anchoredAt', 'reason')
            .where({ passport_ID: rowId.ID })
            .orderBy('version' as any);
        const anchorVersions = (versionRows ?? []).map((v) => ({
            version: Number(v.version), payloadHash: v.payloadHash ?? null,
            contractAddress: v.contractAddress ?? null, anchorNetwork: v.anchorNetwork ?? null,
            attestationTxHash: v.attestationTxHash ?? null,
            anchoredAt: v.anchoredAt ?? null, reason: v.reason ?? null,
        }));
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/passport/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
                body: JSON.stringify({ ...p, claims, anchorVersions }),
                signal: AbortSignal.timeout(30000),
            });
            const body: any = await res.json().catch(() => ({}));
            if (!res.ok) return { published: false, target: url, status: `HTTP ${res.status}: ${body?.error ?? ''}` };
            return { published: true, target: url, status: String(body?.status ?? 'ok') };
        } catch (e: any) {
            return { published: false, target: url, status: `unreachable: ${e?.message ?? e}` };
        }
    };

    /** Catena-X battery-passport aspect JSON (full structured, producer-owned). */
    private passportAspectJson = async (req: cds.Request) => {
        const { passportId } = req.data as { passportId?: string };
        const p: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'manufacturerId', 'batteryCategory', 'model', 'manufactureDate',
                'weightKg', 'performanceClass', 'qrCodeUrl', 'payloadHash', 'passportIdHash',
                'contractAddress', 'attestationTxHash', 'status')
            .where({ passportId });
        if (!p) return req.reject(404, `passport '${passportId}' not found`);
        const cells: any[] = await SELECT.from(Batteries)
            .columns('serialNumber', 'cellChemistry', 'capacityKwh', 'carbonFootprintKgCO2',
                'recycledContentPct', 'cycleLife', 'roundTripEfficiencyPct', 'leadContentPpm', 'supplierName')
            .where({ passport_ID: p.ID });
        const recycled: any[] = await SELECT.from(RecycledMaterials)
            .columns('material', 'recycledPercentage', 'sourceSupplierName').where({ passport_ID: p.ID });
        const diligence: any[] = await SELECT.from(DiligenceDoc).columns('docType').where({ passport_ID: p.ID });
        const hex0x = (h: unknown) => (h ? `0x${String(h).replace(/^0x/, '')}` : null);
        const aspect = {
            aspect: 'urn:samm:io.catenax.battery.battery_pass:6.0.0#BatteryPass',
            profile: 'EU 2023/1542 Annex XIII · Catena-X CX-0143',
            passportId: p.passportId,
            general: {
                manufacturerId: p.manufacturerId,
                batteryCategory: p.batteryCategory,
                model: p.model,
                manufactureDate: p.manufactureDate,
                weightKg: p.weightKg,
                performanceClass: p.performanceClass,
                qrCodeUrl: p.qrCodeUrl
            },
            cells,
            recycledContent: recycled,
            dueDiligence: diligence,
            integrity: {
                payloadHash: p.payloadHash,
                passportIdHash: p.passportIdHash,
                contractAddress: hex0x(p.contractAddress),
                attestationTxHash: hex0x(p.attestationTxHash),
                status: p.status,
                anchored: p.status === 'anchored' && !!p.attestationTxHash
            }
        };
        return JSON.stringify(aspect, null, 2);
    };

    /** Predicate Attestation Credential (PAC) from the passport's succeeded proofs. */
    private passportCredential = async (req: cds.Request) => {
        const { passportId } = req.data as { passportId?: string };
        const p: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'manufacturerId', 'model', 'batteryCategory',
                'contractAddress', 'anchorNetwork', 'attestationTxHash', 'status', 'payloadHash')
            .where({ passportId });
        if (!p) return req.reject(404, `passport '${passportId}' not found`);
        const proofs: any[] = await SELECT.from(PredicateProofLog)
            .columns('sourceField', 'predicate', 'threshold', 'unit', 'txHash', 'result')
            .where({ passport_ID: p.ID, status: 'succeeded' });
        const explorer = (h: unknown) => explorerTxUrl(h as string | null, p.anchorNetwork);
        const hex0x = (h: unknown) => (h ? `0x${String(h).replace(/^0x/, '')}` : null);
        const credential = {
            '@context': ['https://www.w3.org/ns/credentials/v2', 'https://catena-x.net/schema/pac/v1'],
            type: ['VerifiableCredential', 'PredicateAttestationCredential'],
            id: `urn:bpass:${p.passportId}`,
            profile: 'Catena-X CX-0143 Battery Passport',
            issuanceDate: new Date().toISOString(),
            credentialSubject: {
                passportId: p.passportId,
                standard: 'EU 2023/1542 Annex XIII',
                batteryCategory: p.batteryCategory,
                model: p.model,
                manufacturerId: p.manufacturerId,
                payloadHash: p.payloadHash,
                attestation: {
                    contractAddress: hex0x(p.contractAddress),
                    transactionHash: hex0x(p.attestationTxHash),
                    status: p.status,
                    // `locallyAnchored` is a DB-state assertion (anchored + tx present),
                    // NOT an on-chain re-verification. A verifier should resolve the tx.
                    locallyAnchored: p.status === 'anchored' && !!p.attestationTxHash,
                    explorer: explorer(p.attestationTxHash)
                },
                predicateProofs: proofs.map((pr) => ({
                    sourceField: pr.sourceField,
                    claim: `${pr.sourceField} ${pr.predicate} ${pr.threshold}${pr.unit ? ' ' + pr.unit : ''}`,
                    operator: pr.predicate,
                    threshold: pr.threshold,
                    unit: pr.unit,
                    valueDisclosed: false,
                    result: pr.result,
                    transactionHash: hex0x(pr.txHash),
                    verificationModel: 'indexer-trust',
                    explorer: explorer(pr.txHash)
                }))
            }
        };
        return JSON.stringify(credential, null, 2);
    };

    /**
     * Persist a wallet-driven (in-app Lace) predicate proof.
     *
     * A predicate that does not hold is rejected in-circuit (no tx lands), so a
     * claimed `result:false` is recorded `failed` immediately. A claimed success
     * is held `pending` until the proof tx is structurally verified on-chain, so
     * a fabricated txHash never surfaces as a proven claim in the PAC.
     */
    private recordWalletPredicate = async (req: cds.Request) => {
        const { passportId, sourceField, predicate, threshold, unit, txHash, result } = req.data as
            { passportId?: string; sourceField?: string; predicate?: string; threshold?: number; unit?: string; txHash?: string; result?: boolean };
        const pred = predicate === 'greaterOrEqual' ? 'greaterOrEqual' : 'lessOrEqual';
        return this.recordWalletProofRow(req, {
            passportId, sourceField, txHash, result,
            logColumns: { predicate: pred, threshold: Number(threshold ?? 0), unit },
            // Crawler-free: confirm the vault recorded a true result for this
            // field-bound claim. The cockpit sends the already-scaled
            // threshold the proof hashed, so it is passed straight through.
            stateCheckFor: (contract, payloadHash) => verifyPredicateState({
                contractAddress: contract, payloadHash,
                fieldKey: fieldKeyHex(String(sourceField)), predicate: pred, threshold: Number(threshold ?? 0)
            })
        });
    };

    /**
     * Record a browser-wallet membership proof (membership rows carry a
     * setRoot instead of a threshold). Settles crawler-free against the
     * vault's field_membership_results map.
     */
    private recordWalletMembership = async (req: cds.Request) => {
        const { passportId, sourceField, setId, setRoot, txHash, result } = req.data as
            { passportId?: string; sourceField?: string; setId?: string; setRoot?: string; txHash?: string; result?: boolean };
        const root = norm(setRoot).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(root)) return req.reject(400, 'setRoot must be 32-byte hex (64 chars)');
        return this.recordWalletProofRow(req, {
            passportId, sourceField, txHash, result,
            logColumns: {
                predicate: 'setMembership', threshold: null, unit: null,
                setRoot: root, setId: String(setId ?? '').slice(0, 60) || null
            },
            stateCheckFor: (contract, payloadHash) => verifyPredicateState({
                contractAddress: contract, payloadHash,
                fieldKey: fieldKeyHex(String(sourceField)), predicate: 'setMembership', setRoot: root
            })
        });
    };

    /**
     * Shared choreography of the wallet-driven proof records: one
     * PredicateProofLog row + one PassportTransactions row, an immediate
     * failed pair when the circuit rejected locally (result:false), else a
     * pending pair settled via the claim-kind-specific crawler-free state
     * check. The claim kinds differ only in their log columns and the state
     * check; everything else stays one implementation.
     */
    private async recordWalletProofRow(req: cds.Request, o: {
        passportId?: string; sourceField?: string; txHash?: string; result?: boolean;
        logColumns: Record<string, unknown>;
        stateCheckFor: (contract: string, payloadHash: string) => Promise<ChainVerdict>;
    }) {
        const row: any = await this.passportRef(String(o.passportId ?? ''));
        if (!row) return req.reject(404, `passport '${o.passportId}' not found`);
        // The state check keys the vault map by blake2b(sourceField); an
        // absent field would probe blake2b('') and silently degrade the
        // verification to tx-shape checking.
        if (!String(o.sourceField ?? '').trim()) return req.reject(400, 'sourceField is required');
        const hash = norm(o.txHash);
        const contract = row.contractAddress || this.contractAddress();
        const proofLogId = cds.utils.uuid();
        const txRowId = cds.utils.uuid();
        const logRow = {
            passport_ID: row.ID, sourceField: o.sourceField, ...o.logColumns,
            payloadHash: row.payloadHash ?? null
        };

        if (o.result === false) {
            await INSERT.into(PredicateProofLog).entries({
                ID: proofLogId, ...logRow, txHash: hash || null, status: 'failed', result: false
            } as any);
            await INSERT.into(PassportTransactions).entries({
                ID: txRowId, passport_ID: row.ID, kind: 'provePredicate', txHash: hash || null,
                status: 'failed', explorerUrl: hash ? txExplorerUrl(hash) : null
            } as any);
            return { ok: true, txHash: hash, status: 'failed' };
        }

        await INSERT.into(PredicateProofLog).entries({
            ID: proofLogId, ...logRow, txHash: hash || null, status: 'pending', result: true
        } as any);
        await INSERT.into(PassportTransactions).entries({
            ID: txRowId, passport_ID: row.ID, kind: 'provePredicate', txHash: hash || null,
            status: 'pending', explorerUrl: hash ? txExplorerUrl(hash) : null
        } as any);

        const verdict = await this.settleWalletTx({
            txHash: hash, contractAddress: contract,
            stateCheck: () => o.stateCheckFor(contract, row.payloadHash),
            onConfirmed: async () => {
                await UPDATE.entity(PredicateProofLog).set({ status: 'succeeded' }).where({ ID: proofLogId });
                await UPDATE.entity(PassportTransactions).set({ status: 'succeeded' }).where({ ID: txRowId });
            },
            onFailed: async () => {
                await UPDATE.entity(PredicateProofLog).set({ status: 'failed', result: false }).where({ ID: proofLogId });
                await UPDATE.entity(PassportTransactions).set({ status: 'failed', errorMessage: 'tx not verified on-chain' }).where({ ID: txRowId });
            }
        });
        return { ok: verdict !== 'failed', txHash: hash, status: walletStatus(verdict) };
    }

    // --- wallet-tx settlement -------------------------------------------------

    /** Run a DB op in its own short root transaction (commits immediately). */
    private runDetached<T>(fn: () => Promise<T>): Promise<T> {
        return (cds as any).tx({}, fn);
    }

    /**
     * Verify a wallet-submitted action's on-chain effect, then finalize the row.
     *
     * Prefers crawler-free STATE verification (`stateCheck` reads the
     * AttestationVault ledger via `queryContractState`, so it confirms the
     * outcome with the block crawler off, the demo default). It falls back to the
     * tx-based indexer check (`verifyContractTx`) only when the state check is
     * absent or inconclusive; that tx path is also the only one that can return a
     * definitive `failed` (an indexed tx whose result is FAILURE or wrong target).
     *
     * On `confirmed` it finalizes now; on `failed` it marks the row failed; on
     * `unknown` (nothing confirms yet: effect not settled, no live provider, or
     * indexer lagging) it leaves the row PENDING and retries detached for a bounded
     * window. A row is never promoted to succeeded on the client's word alone.
     */
    private async settleWalletTx(o: {
        txHash: string;
        contractAddress?: string | null;
        stateCheck?: () => Promise<ChainVerdict>;
        onConfirmed: () => Promise<void>;
        onFailed: () => Promise<void>;
    }): Promise<ChainVerdict> {
        const check = async (): Promise<ChainVerdict> => {
            if (o.stateCheck) {
                let state: ChainVerdict = 'unknown';
                try { state = await o.stateCheck(); } catch { state = 'unknown'; }
                if (state === 'confirmed' || state === 'failed') return state;
            }
            try { return await verifyContractTx(o.txHash, { contractAddress: o.contractAddress }); }
            catch { return 'unknown'; }
        };
        let verdict: ChainVerdict = 'unknown';
        try { verdict = await check(); } catch { verdict = 'unknown'; }
        if (verdict === 'confirmed') { await o.onConfirmed(); return verdict; }
        if (verdict === 'failed') { await o.onFailed(); return verdict; }
        // unknown: the effect may not have settled / the indexer may be lagging.
        // Retry off the request path.
        if (o.txHash || o.stateCheck) this.trackWalletTx(check, o.onConfirmed, o.onFailed);
        return verdict;
    }

    /** Detached bounded poll: re-verify until the indexer resolves, else stay pending. */
    private trackWalletTx(
        check: () => Promise<ChainVerdict>, onConfirmed: () => Promise<void>, onFailed: () => Promise<void>
    ): void {
        setImmediate(async () => {
            for (let i = 0; i < 12; i++) {
                await new Promise((r) => setTimeout(r, 5000));
                let verdict: ChainVerdict = 'unknown';
                try { verdict = await check(); } catch { /* keep polling */ }
                if (verdict === 'confirmed') { await this.runDetached(onConfirmed); return; }
                if (verdict === 'failed') { await this.runDetached(onFailed); return; }
            }
            // Never confirmed within the window (e.g. crawler disabled): stays pending.
        });
    }

    /**
     * Shared anchor entry: mark the row 'anchoring' and run the on-chain
     * sequence (attest + bindPassport + contentRoot) DETACHED from this
     * request, after its transaction committed.
     *
     * Waiting inline would deadlock the very work we wait on: this handler's
     * request tx holds a pooled SQLite connection and the write lock, and the
     * NIGHTGATE background job needs both to even start. The job would only
     * run after our own timeout rolled the request back (observed live as
     * "10-15 minutes per anchor step"; the real anchor takes seconds). So the
     * action returns mode 'anchoring' immediately; every detached step commits
     * its own short tx; clients poll the Passports row until 'anchored' or
     * 'failed' and read PassportTransactions for the per-step tx hashes.
     */
    private async anchorRow(
        req: cds.Request, ID: string, passportId: string, payloadHash: string,
        passportIdHash: string, contractAddress: string, sessionId: string, includePayloadHash: boolean,
        sponsorWalletId?: string
    ) {
        // The vault's attest circuit asserts the payload hash is not attested
        // yet, so byte-identical confidential content can never anchor twice.
        // Fail fast with a pointer instead of a detached job failure. Note the
        // trap: Point-1 fields (model, weight, ...) are NOT part of the hash;
        // only batteries / recycledMaterials / diligenceDocs are.
        const dupe: any = await SELECT.one.from(Passports).columns('passportId')
            .where({ payloadHash, status: { in: ['anchored', 'anchoring'] }, ID: { '!=': ID } } as any);
        if (dupe) {
            return req.reject(409,
                `content is identical to passport '${dupe.passportId}' (same payloadHash; the vault rejects a second attest of the same hash). ` +
                `Change a confidential field, e.g. a cell serial number. Point-1 fields like model or weight do not enter the hash.`);
        }
        await UPDATE.entity(Passports).set({ status: 'anchoring' }).where({ ID });
        // The draft placeholder ('attest'/'offline' from createPassport) is now
        // superseded by the real anchor steps; without this it stays in the tx
        // list next to the succeeded attest forever.
        await DELETE.from(PassportTransactions).where({ passport_ID: ID, kind: 'attest', status: 'offline' });
        // Content-root inputs must be read HERE: the row's children may still be
        // uncommitted in this request's tx and invisible to a detached reader.
        //
        // The tree is SALTED (NIGHTGATE 0.16.0): this version gets a fresh seed,
        // and that seed plus the schema id are persisted with the row in THIS
        // transaction, before any chain work starts. Order matters: a seed that
        // reached the chain but not the database would leave an anchored root
        // nobody can ever rebuild, and every later claim on this passport would
        // abort at local proving with no way back except a re-anchor.
        let contentRoot: string | undefined;
        let schemaId: string | undefined;
        try {
            const values = await this.fieldValuesFor(ID);
            if (Object.keys(values).length) {
                const tree = await buildContentRoot(values, { saltSeed: newSaltSeed() });
                contentRoot = tree.contentRoot;
                schemaId = tree.schemaId;
                await this.persistContentTree(ID, tree);
            }
        } catch (e) {
            cds.log('producer').warn('content-root build skipped:', (e as Error)?.message);
        }
        // Sponsor session must be resolved HERE (request context: session
        // opening inherits the request's user); the detached runner just
        // carries the id.
        const sponsorSessionId = await this.sponsorSessionIdFor(sessionId, sponsorWalletId);
        // 'succeeded' fires after the request tx committed, so the detached
        // runner never contends with this request for the write lock. The
        // user is captured NOW: the NIGHTGATE calls must carry the caller's
        // identity (wallet sessions are bound to the owning userId).
        const user = req.user;
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() =>
                this.runAnchorDetached(ID, passportId, payloadHash, passportIdHash, contractAddress, sessionId, user, contentRoot, sponsorSessionId, schemaId)
            ).catch((e: unknown) =>
                cds.log('producer').error(`detached anchor runner crashed for ${passportId}:`, e));
        });
        // Return the anchored content root so the caller can pass it back to
        // verifyAttestationState (contentRootOk is only meaningful with it).
        return { passportId, payloadHash: includePayloadHash ? payloadHash : undefined, contentRoot: contentRoot ?? '', mode: 'anchoring', txHash: '' };
    }

    /**
     * The long-running on-chain leg of anchorRow. Runs with no ambient tx;
     * every DB write is its own short root tx (runDetached). Failures land on
     * the row (status 'failed') plus a failed PassportTransactions entry, not
     * on an HTTP response: the request that started this is long gone.
     */
    /**
     * The chain lane behind a session handle: a registered remote signer
     * (the demo's run id) gives the hosted-API lane, any other id the
     * in-process plugin lane (after its pending prewarm job, if any).
     */
    private async laneFor(sessionId: string, user: unknown, sponsorSessionId?: string): Promise<ChainLane> {
        if (hasRemoteSigner(sessionId)) return remoteLaneFor(sessionId);
        const nightgate = await cds.connect.to('NightgateService');
        // First action on a fresh server signing session: the facade is still
        // being built/synced by the prewarm job; submitting earlier fails with
        // "No facade for sessionId". Await it once (detached context, short
        // read polls only).
        const prewarmJob = this.serverPrewarmJobs.get(sessionId);
        if (prewarmJob) {
            this.serverPrewarmJobs.delete(sessionId);
            const log = cds.log('producer');
            log.info(`awaiting server-session prewarm ${prewarmJob} before the first chain call...`);
            await waitForJobResult(nightgate, prewarmJob, sessionId, user);
            log.info('server-session prewarm complete');
        }
        return new PluginLane(nightgate, sessionId, user, sponsorSessionId);
    }

    private async runAnchorDetached(
        ID: string, passportId: string, payloadHash: string, passportIdHash: string,
        contractAddress: string, sessionId: string, user: unknown, contentRoot?: string,
        sponsorSessionId?: string, schemaId?: string
    ): Promise<void> {
        const log = cds.log('producer');
        let lane: ChainLane | null = null;
        try {
            lane = await this.laneFor(sessionId, user, sponsorSessionId);
            if (sponsorSessionId) log.info(`anchor fees for ${passportId} sponsored by session ${sponsorSessionId.slice(0, 8)}...`);
            const { attestationTxHash } = await anchorPassport(lane, {
                payloadHash, passportId, passportIdHash, contractAddress, contentRoot, schemaId,
                onStep: async (s) => {
                    await this.runDetached(async () => {
                        await INSERT.into(PassportTransactions).entries({
                            passport_ID: ID, kind: s.kind, jobId: s.jobId, txHash: s.txHash,
                            status: 'succeeded', explorerUrl: txExplorerUrl(s.txHash)
                        } as any);
                    });
                    log.info(`anchor step ${s.kind} for ${passportId}: ${s.txHash}`);
                }
            });
            await this.runDetached(async () => {
                await UPDATE.entity(Passports).set({ status: 'anchored', attestationTxHash, contractAddress }).where({ ID });
            });
            log.info(`passport ${passportId} anchored: ${attestationTxHash}`);
        } catch (e) {
            const msg = String((e as Error)?.message || (e as Error)?.name || e);
            log.warn(`on-chain anchor failed for ${passportId}:`, e);
            await this.runDetached(async () => {
                await UPDATE.entity(Passports).set({ status: 'failed' }).where({ ID });
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: ID, kind: 'attest', status: 'failed', errorMessage: msg
                } as any);
            }).catch(() => { /* status update is best-effort */ });
        } finally {
            await lane?.dispose().catch(() => { /* nothing left to release */ });
        }
    }

    // --- disclosure ----------------------------------------------------------

    private grantPassportDisclosure = async (req: cds.Request) => {
        const { passportId, grantee, level, sessionId, walletId } = req.data as
            { passportId?: string; grantee?: string; level?: number; sessionId?: string; walletId?: string };
        return this.disclosure(req, 'grant', String(passportId ?? ''), String(grantee ?? ''), Number(level ?? 0), sessionId, walletId);
    };

    private revokePassportDisclosure = async (req: cds.Request) => {
        const { passportId, grantee, sessionId, walletId } = req.data as
            { passportId?: string; grantee?: string; sessionId?: string; walletId?: string };
        return this.disclosure(req, 'revoke', String(passportId ?? ''), String(grantee ?? ''), 0, sessionId, walletId);
    };

    private async disclosure(req: cds.Request, op: 'grant' | 'revoke', passportId: string, grantee: string, level: number, argSession?: string, walletId?: string) {
        if (!grantee) return req.reject(400, 'grantee is required');
        const row: any = await this.passportRef(passportId);
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const contractAddress = this.vaultFor(row);
        const session = await this.effectiveSession(argSession, walletId);

        if (!session || !contractAddress) {
            await INSERT.into(DisclosureGrantLog).entries({ passport_ID: row.ID, grantee, level, op, status: 'offline' } as any);
            return { mode: 'offline', txHash: '' };
        }
        // Detached like anchorRow/prove: record a pending log row, run the
        // chain call after commit, let the client poll the row. The read gate
        // ignores 'pending' rows (it only counts succeeded/offline), so a
        // pending grant never elevates a tier early.
        const grantLogId = cds.utils.uuid();
        await INSERT.into(DisclosureGrantLog).entries({
            ID: grantLogId, passport_ID: row.ID, grantee, level, op, status: 'pending'
        } as any);
        const action = op === 'grant' ? 'grantDisclosure' : 'revokeDisclosure';
        const args: Record<string, unknown> = {
            payloadHash: row.payloadHash, grantee, sessionId: session,
            contractAddress, compiledArtifactRef: CONTRACT_REF
        };
        if (op === 'grant') args.level = level;
        const sponsorSessionId = await this.sponsorSessionIdFor(String(session));
        if (sponsorSessionId) args.sponsorSessionId = sponsorSessionId;
        const user = req.user;
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() =>
                this.runDisclosureDetached(grantLogId, row.ID, op, action, args, String(session), user)
            ).catch((e: unknown) =>
                cds.log('producer').error(`detached ${op} runner crashed for ${passportId}:`, e));
        });
        return { mode: op === 'grant' ? 'granting' : 'revoking', txHash: '', grantLogId };
    }

    /** The long-running on-chain leg of disclosure(); same pattern as the anchor/prove runners. */
    private async runDisclosureDetached(
        grantLogId: string, passportRowId: string, op: 'grant' | 'revoke',
        action: string, args: Record<string, unknown>, sessionId: string, user: unknown
    ): Promise<void> {
        const log = cds.log('producer');
        try {
            const nightgate = await cds.connect.to('NightgateService');
            const prewarmJob = this.serverPrewarmJobs.get(sessionId);
            if (prewarmJob) {
                this.serverPrewarmJobs.delete(sessionId);
                await waitForJobResult(nightgate, prewarmJob, sessionId, user);
            }
            const res: any = await sendDetached(nightgate, action, args, user);
            const txHash = await waitForJob(nightgate, res.jobId, sessionId, user);
            await this.runDetached(async () => {
                await UPDATE.entity(DisclosureGrantLog).set({ status: 'succeeded', txHash }).where({ ID: grantLogId });
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: op === 'grant' ? 'grantDisclosure' : 'revokeDisclosure',
                    jobId: res.jobId, txHash, status: 'succeeded', explorerUrl: txExplorerUrl(txHash)
                } as any);
            });
            log.info(`${op} settled for log ${grantLogId}: ${txHash}`);
        } catch (e) {
            const msg = String((e as Error)?.message ?? e).slice(0, 500);
            log.warn(`${op} failed for log ${grantLogId}:`, e);
            await this.runDetached(async () => {
                await UPDATE.entity(DisclosureGrantLog).set({ status: 'failed' }).where({ ID: grantLogId });
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: op === 'grant' ? 'grantDisclosure' : 'revokeDisclosure',
                    status: 'failed', errorMessage: msg
                } as any);
            });
        }
    }

    // --- predicate proof -----------------------------------------------------

    private provePassportValue = async (req: cds.Request) => {
        const { passportId, sourceField, predicate, threshold, unit, sessionId, walletId, sponsorWalletId } = req.data as {
            passportId?: string; sourceField?: string; predicate?: string;
            threshold?: number; unit?: string; sessionId?: string; walletId?: string; sponsorWalletId?: string;
        };
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);

        // Resolve the value from the passport's battery. carbonFootprintKgCO2 is
        // the canonical predicate field. Scale ×1000 to an integer (milli-units)
        // for the Uint<64> circuit; threshold is scaled the same way.
        if (predicate === 'setMembership') {
            return req.reject(400, 'membership claims go through provePassportValuesBatch (the proof cart)');
        }
        const field = sourceField || 'carbonFootprintKgCO2';
        const values = await this.fieldValuesFor(row.ID);
        const rawValue = values[field];
        if (rawValue == null) return req.reject(400, `value for '${field}' not found on this passport`);

        const thresholdScaled = Math.round(Number(threshold ?? 0) * 1000);
        const pred = predicate === 'greaterOrEqual' ? 'greaterOrEqual' : 'lessOrEqual';
        const useUnit = unit || 'milli-kg CO2 / kWh';
        const session = await this.effectiveSession(sessionId, walletId);
        const contractAddress = this.vaultFor(row, sessionId);

        if (!session || !contractAddress) {
            await INSERT.into(PredicateProofLog).entries({
                passport_ID: row.ID, sourceField: field, predicate: pred,
                threshold: thresholdScaled, unit: useUnit, status: 'offline', payloadHash: row.payloadHash ?? null
            } as any);
            return { mode: 'offline', txHash: '', predicateAttestationId: '', result: null };
        }

        // Build the field-bound inclusion proof + content root. The proven value
        // is thus cryptographically tied to THIS passport's field, not a free
        // witness. Only PROVABLE_FIELDS are supported. (`values` already resolved.)
        // Rebuilt with the ANCHORED salt seed; without it the root would differ
        // from the ledger's and the circuit would abort after minutes of proving.
        const { tree, saltSeed } = await this.contentTreeFor(row.ID, values);
        const proof = tree.proofFor(field);
        if (!proof) return req.reject(400, `field '${field}' is not a provable field`);
        if (proof.kind !== 'numeric') {
            return req.reject(400, `field '${field}' is a string field; prove it via a membership claim in the proof cart`);
        }

        // Detached like anchorRow: the ZK proof takes tens of seconds; holding
        // the request (and the UI) open for it is pointless and its request tx
        // would go snapshot-stale. Record a pending log row now, run the proof
        // after commit, and let the client poll the row.
        const proofLogId = cds.utils.uuid();
        await INSERT.into(PredicateProofLog).entries({
            ID: proofLogId, passport_ID: row.ID, sourceField: field, predicate: pred,
            threshold: thresholdScaled, unit: useUnit, status: 'pending', payloadHash: row.payloadHash ?? null
        } as any);
        // The proof circuit binds against the root in the LEDGER; the worker
        // only (idempotently) re-anchors when `contentRoot` is supplied. Our
        // anchor sequence anchors the root at attest and passport content is
        // immutable after create, so re-sending it would just buy a redundant
        // anchorContentRoot tx (fee, ~20s, a confusing duplicate row). Supply
        // it only when no anchored root exists yet for this passport.
        const rootAnchored = await this.contentRootAnchored(row.ID);
        if (rootAnchored && !saltSeed) {
            return req.reject(409, `the anchored content root of '${row.passportId}' has no stored salt seed ` +
                '(anchored before the salted-leaf release); re-anchor the passport before proving');
        }
        // This call is about to anchor the root itself (no root on-chain yet),
        // so the seed it was built from becomes THE opening of that anchor and
        // must be persisted before the chain sees it.
        if (!rootAnchored) await this.persistContentTree(row.ID, tree);
        const sponsorSessionId = await this.sponsorSessionIdFor(String(session), sponsorWalletId);
        const args = {
            payloadHash: row.payloadHash, fieldKey: proof.fieldKey, value: proof.value,
            fieldSalt: proof.salt,
            ...(rootAnchored ? {} : { contentRoot: tree.contentRoot, schemaId: tree.schemaId }),
            siblingsJson: JSON.stringify(proof.siblings), dirsJson: JSON.stringify(proof.dirs),
            predicate: pred, threshold: thresholdScaled, unit: useUnit,
            sessionId: session, contractAddress, compiledArtifactRef: CONTRACT_REF,
            ...(sponsorSessionId ? { sponsorSessionId } : {})
        };
        const user = req.user;
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() =>
                this.runProveDetached(proofLogId, row.ID, args, user)
            ).catch((e: unknown) =>
                cds.log('producer').error(`detached prove runner crashed for ${row.passportId}:`, e));
        });
        return { mode: 'proving', txHash: '', predicateAttestationId: '', result: null, proofLogId };
    };

    /**
     * Proof cart, server lane (NIGHTGATE >= 0.12.0). Shares the claim
     * contract with the browser cart via proofCartPlan; the platform batch
     * action re-validates and re-dedups server-side, so the plan here mainly
     * buys the SAME error surface and drop reporting on both lanes.
     */
    private provePassportValuesBatch = async (req: cds.Request) => {
        const { passportId, claimsJson, sessionId, walletId, sponsorWalletId } = req.data as {
            passportId?: string; claimsJson?: string; sessionId?: string; walletId?: string; sponsorWalletId?: string;
        };
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        if (!row.payloadHash) return req.reject(400, 'passport has no payload hash yet');
        let items: any[];
        try { items = JSON.parse(String(claimsJson ?? '')); } catch { items = null as any; }
        if (!Array.isArray(items) || !items.length) return req.reject(400, 'claimsJson must be a non-empty JSON array');

        const { values, tree, saltSeed } = await this.contentTreeFor(row.ID);
        type CartEntry =
            | {
                kind: 'predicate'; field: string; pred: 'lessOrEqual' | 'greaterOrEqual';
                thresholdScaled: number; unit: string;
                proof: Extract<NonNullable<ReturnType<typeof tree.proofFor>>, { kind: 'numeric' }>;
            }
            | {
                kind: 'membership'; field: string; setId: string; setLabel: string;
                setRoot: string; allowedValues: readonly string[];
                proof: Extract<NonNullable<ReturnType<typeof tree.proofFor>>, { kind: 'string' }>;
            };
        const entries: CartEntry[] = [];
        for (const it of items) {
            const field = String(it?.sourceField ?? '');
            if (values[field] == null) return req.reject(400, `value for '${field}' not found on this passport`);
            const proof = tree.proofFor(field);
            if (!proof) return req.reject(400, `field '${field}' is not a provable field`);
            if (it?.predicate === 'setMembership') {
                const setId = String(it?.setId ?? '');
                const set = claimSetById(setId);
                if (!set) return req.reject(400, `unknown claim set '${setId}'`);
                if (set.sourceField !== field) {
                    return req.reject(400, `claim set '${setId}' applies to '${set.sourceField}', not '${field}'`);
                }
                if (proof.kind !== 'string') return req.reject(400, `field '${field}' is not a string provable field`);
                // Member check BEFORE any session/proving work, mirroring
                // NIGHTGATE's non-member 400 before rate spend.
                if (!set.values.includes(String(values[field]))) {
                    return req.reject(400, `'${field}' value is not in set '${set.label}'`);
                }
                const memberSet = await buildMembershipSet(set.values);
                entries.push({
                    kind: 'membership', field, setId, setLabel: set.label,
                    setRoot: memberSet.setRoot, allowedValues: set.values, proof
                });
            } else {
                if (proof.kind !== 'numeric') {
                    return req.reject(400, `field '${field}' is a string field; prove it via a setMembership claim`);
                }
                entries.push({
                    kind: 'predicate', field,
                    pred: it?.predicate === 'greaterOrEqual' ? 'greaterOrEqual' : 'lessOrEqual',
                    thresholdScaled: Math.round(Number(it?.threshold ?? 0) * 1000),
                    unit: String(it?.unit ?? ''),
                    proof
                });
            }
        }
        // Shared plan: validates and drops exact duplicates the same way the
        // browser cart does (claim keys are idempotent on-chain anyway).
        const planClaimOf = (e: CartEntry): ProofClaim => e.kind === 'membership'
            ? { kind: 'membership', fieldKey: e.proof.fieldKey, setRoot: e.setRoot }
            : { fieldKey: e.proof.fieldKey, threshold: e.thresholdScaled, op: e.pred === 'greaterOrEqual' ? 1 : 0 };
        let plan;
        try {
            plan = proofCartPlan({ payloadHash: row.payloadHash, claims: entries.map(planClaimOf) });
        } catch (e: any) {
            return req.reject(400, String(e?.message ?? e));
        }
        const byKey = new Map(entries.map((e) => [claimKey(planClaimOf(e)), e]));
        const kept = plan.claims.map((c) => byKey.get(claimKey(c))!);

        const logRowOf = (e: CartEntry) => e.kind === 'membership'
            ? {
                sourceField: e.field, predicate: 'setMembership', threshold: null, unit: null,
                setRoot: e.setRoot, setId: e.setId
            }
            : { sourceField: e.field, predicate: e.pred, threshold: e.thresholdScaled, unit: e.unit };

        const session = await this.effectiveSession(sessionId, walletId);
        const contractAddress = this.vaultFor(row, sessionId);
        if (!session || !contractAddress) {
            // Own short root tx: the tree/set builds above can take seconds
            // (first WASM load), long enough for a worker facade save to
            // stale this request tx's snapshot (BUSY_SNAPSHOT rule, 07-15).
            await this.runDetached(async () => {
                await INSERT.into(PredicateProofLog).entries(kept.map((e) => ({
                    passport_ID: row.ID, ...logRowOf(e), status: 'offline', payloadHash: row.payloadHash ?? null
                })) as any);
            });
            return { mode: 'offline', proofLogIds: '[]', dropped: plan.dropped.length };
        }

        // In-batch root anchor only when none exists yet (same rule as the
        // single action); it occupies one of the 8 call slots.
        const rootAnchored = await this.contentRootAnchored(row.ID);
        if (rootAnchored && !saltSeed) {
            return req.reject(409, `the anchored content root of '${row.passportId}' has no stored salt seed ` +
                '(anchored before the salted-leaf release); re-anchor the passport before proving');
        }
        const maxClaims = rootAnchored ? 8 : 7;
        if (kept.length > maxClaims) {
            return req.reject(400, `at most ${maxClaims} claims per cart` +
                (rootAnchored ? '' : ' (the content-root anchor occupies one of the 8 call slots)'));
        }
        // Root-drift pre-flight: an anchored root that no longer matches the
        // freshly built tree (the provable-field registry changed since the
        // anchor) fails EVERY claim at local proving. Reject with the fix
        // instead; an unreachable indexer degrades to the honest in-circuit
        // abort (verdict 'unknown' proceeds).
        if (rootAnchored) {
            const rootVerdict = await attestRootState({
                contractAddress, payloadHash: row.payloadHash, contentRoot: tree.contentRoot, schemaId: tree.schemaId
            });
            if (rootVerdict === 'mismatch') {
                return req.reject(409, `the anchored content root of '${row.passportId}' predates the current ` +
                    'provable-field layout; re-anchor (re-attest) the passport before proving');
            }
        }

        // Own short root tx (see the offline branch): the drift pre-flight
        // above is a live indexer read that can hold this request open long
        // enough for worker commits to stale its snapshot.
        const proofLogIds = kept.map(() => cds.utils.uuid());
        await this.runDetached(async () => {
            await INSERT.into(PredicateProofLog).entries(kept.map((e, i) => ({
                ID: proofLogIds[i], passport_ID: row.ID, ...logRowOf(e),
                status: 'pending', payloadHash: row.payloadHash ?? null
            })) as any);
        });

        if (!rootAnchored) await this.persistContentTree(row.ID, tree);
        const sponsorSessionId = await this.sponsorSessionIdFor(String(session), sponsorWalletId);
        const cart: ProofCartInput = {
            contractAddress, payloadHash: row.payloadHash,
            ...(rootAnchored ? {} : { contentRoot: tree.contentRoot, schemaId: tree.schemaId }),
            claims: kept.map((e): CartClaimArgs => (e.kind === 'membership'
                ? {
                    fieldKey: e.proof.fieldKey, value: String(values[e.field]),
                    allowedValues: e.allowedValues, salt: e.proof.salt,
                    siblings: e.proof.siblings, dirs: e.proof.dirs,
                    predicate: 'setMembership'
                }
                : {
                    fieldKey: e.proof.fieldKey, value: e.proof.value, salt: e.proof.salt,
                    siblings: e.proof.siblings, dirs: e.proof.dirs,
                    predicate: e.pred, threshold: e.thresholdScaled,
                    ...(e.unit ? { unit: e.unit } : {})
                })),
            // One ZK proof per claim, so the wait budget scales with the cart.
            // In-process (wasm) proving is minutes per claim; the default 10
            // minutes covers an anchor batch but not a four-claim cart.
            timeoutMs: (10 + 8 * Math.max(0, kept.length - 1)) * 60_000
        };
        const user = req.user;
        const claimMeta: ProofClaimMeta[] = kept.map((e, i) => ({
            proofLogId: proofLogIds[i],
            key: responseClaimKey(e.kind === 'membership'
                ? { fieldKey: e.proof.fieldKey, predicate: 'setMembership', setRoot: e.setRoot }
                : { fieldKey: e.proof.fieldKey, predicate: e.pred, threshold: e.thresholdScaled })!,
            fieldKey: e.proof.fieldKey,
            ...(e.kind === 'membership'
                ? { predicate: 'setMembership' as const, setRoot: e.setRoot }
                : { predicate: e.pred, threshold: e.thresholdScaled })
        }));
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() =>
                this.runProveBatchDetached(claimMeta, row.ID, !rootAnchored, cart, String(session), sponsorSessionId, user)
            ).catch((e: unknown) =>
                cds.log('producer').error(`detached proof-cart runner crashed for ${row.passportId}:`, e));
        });
        return { mode: 'proving', proofLogIds: JSON.stringify(proofLogIds), dropped: plan.dropped.length };
    };

    /**
     * The long-running leg of provePassportValuesBatch: ONE tx for the whole
     * cart. On success every log row gets the SAME txHash and its claim's
     * predicateAttestationId. Failure paths, honestly separated:
     *   - pre-submit failure (a false predicate rejects at local proving, or
     *     the job errors before the mempool): ALL rows flip to failed;
     *   - post-submit PARTIAL_SUCCESS (ledger fallible phase applied a
     *     subset): settle EACH row from the lane's per-claim verify instead
     *     of assuming all-or-nothing (0.12.0 contract).
     */
    private async runProveBatchDetached(
        claimMeta: ProofClaimMeta[],
        passportRowId: string,
        rootInBatch: boolean,
        cart: ProofCartInput,
        sessionId: string,
        sponsorSessionId: string | undefined,
        user: unknown
    ): Promise<void> {
        const log = cds.log('producer');
        let lane: ChainLane | null = null;
        try {
            lane = await this.laneFor(sessionId, user, sponsorSessionId);
            const out = await lane.submitProofCart(cart);
            await this.runDetached(async () => {
                for (const m of claimMeta) {
                    await UPDATE.entity(PredicateProofLog).set({
                        status: 'succeeded', result: true, txHash: out.txHash,
                        predicateAttestationId: out.claimIds.get(m.key) ?? ''
                    }).where({ ID: m.proofLogId });
                }
                if (rootInBatch) {
                    // The root anchor rode in the SAME tx as the proofs.
                    await INSERT.into(PassportTransactions).entries({
                        passport_ID: passportRowId, kind: 'anchorContentRoot', jobId: out.jobId,
                        txHash: out.txHash, status: 'succeeded', explorerUrl: txExplorerUrl(out.txHash)
                    } as any);
                }
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'provePredicate', jobId: out.jobId, txHash: out.txHash,
                    status: 'succeeded', explorerUrl: txExplorerUrl(out.txHash)
                } as any);
            });
            log.info(`proof cart proven (${claimMeta.length} claims, one tx): ${out.txHash}`);
        } catch (e) {
            const msg = String((e as Error)?.message ?? e).slice(0, 500);
            const partial = e instanceof ProofCartError && e.partial;
            const claimIds = e instanceof ProofCartError ? e.claimIds : new Map<string, string>();
            log.warn(`proof cart ${partial ? 'PARTIAL' : 'failed'} for passport row ${passportRowId}:`, e);
            const verdicts = new Map<string, { verified: boolean; txHash: string }>();
            if (partial && lane) {
                // Which claims actually landed? Ask the lane's per-claim
                // verifier; unreachable = leave that row failed (never lie green).
                for (const m of claimMeta) {
                    try {
                        const v = await lane.verifyClaimLanded({
                            key: m.key, predicateAttestationId: claimIds.get(m.key),
                            contractAddress: cart.contractAddress, payloadHash: cart.payloadHash,
                            fieldKey: m.fieldKey, predicate: m.predicate, threshold: m.threshold, setRoot: m.setRoot
                        });
                        if (v.verified) verdicts.set(m.key, v);
                    } catch { /* stays failed */ }
                }
            }
            await this.runDetached(async () => {
                for (const m of claimMeta) {
                    const v = verdicts.get(m.key);
                    if (v?.verified) {
                        await UPDATE.entity(PredicateProofLog).set({
                            status: 'succeeded', result: true, txHash: v.txHash,
                            predicateAttestationId: claimIds.get(m.key) ?? ''
                        }).where({ ID: m.proofLogId });
                    } else {
                        await UPDATE.entity(PredicateProofLog).set({ status: 'failed', result: false })
                            .where({ ID: m.proofLogId });
                    }
                }
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'provePredicate',
                    status: 'failed', errorMessage: msg
                } as any);
            });
        } finally {
            await lane?.dispose().catch(() => { /* nothing left to release */ });
        }
    }

    /**
     * Version integrity: prove that the current version differs from an
     * archived one ONLY in the fields the mask frees (values hidden).
     *
     * Everything that can be decided off-chain is decided off-chain first:
     * both openings must still exist, both rebuilt roots must equal what was
     * anchored, both versions must sit on the SAME vault under the SAME
     * schema, and no unmasked slot may differ. Each of those would otherwise
     * surface as an opaque circuit abort minutes into proving.
     */
    private proveVersionIntegrity = async (req: cds.Request) => {
        const { passportId, fromVersion, allowedFieldsJson, minChangedSlots, sessionId, walletId, sponsorWalletId } = req.data as {
            passportId?: string; fromVersion?: number; allowedFieldsJson?: string; minChangedSlots?: number;
            sessionId?: string; walletId?: string; sponsorWalletId?: string;
        };
        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'owner', 'payloadHash', 'status', 'contractAddress',
                'contentRoot', 'contentSchemaId', 'contentSaltSeed')
            .where({ passportId: String(passportId ?? '') });
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        if (row.status !== 'anchored') {
            return req.reject(400, `passport '${row.passportId}' is '${row.status}'; a version comparison needs two anchored versions`);
        }

        // The mask IS the claim, so it is parsed and validated before anything
        // else: an unknown field name or a vacuous mask is a plain 400.
        let fields: string[] = [];
        if (allowedFieldsJson) {
            try { fields = JSON.parse(String(allowedFieldsJson)); } catch { return req.reject(400, 'allowedFieldsJson must be valid JSON'); }
            if (!Array.isArray(fields) || fields.some((f) => typeof f !== 'string')) {
                return req.reject(400, 'allowedFieldsJson must be a JSON array of field names');
            }
        }
        let mask: number;
        try { mask = allowedMaskFor(fields); } catch (e: any) { return req.reject(400, String(e?.message ?? e)); }

        // Document A: an archived anchor version (default the newest).
        const versions: any[] = await SELECT.from(PassportAnchorVersions)
            .columns('version', 'payloadHash', 'payloadCipher', 'contentRoot', 'contentSchemaId',
                'contentSaltSeed', 'contractAddress')
            .where({ passport_ID: row.ID });
        if (!versions?.length) {
            return req.reject(400, `passport '${row.passportId}' has no archived version yet; re-anchor it once to compare against`);
        }
        const wanted = Number(fromVersion ?? 0);
        const prior = wanted > 0
            ? versions.find((v) => Number(v.version) === wanted)
            : versions.reduce((a, b) => (Number(a.version) > Number(b.version) ? a : b));
        if (!prior) return req.reject(404, `version ${wanted} not found for '${row.passportId}'`);

        // Both documents must be comparable AT ALL: same vault (the circuit
        // reads both anchors from one contract), same schema, distinct hashes,
        // and both openings still stored.
        if (String(prior.contractAddress ?? '').toLowerCase() !== String(row.contractAddress ?? '').toLowerCase()) {
            return req.reject(409, `version ${prior.version} of '${row.passportId}' is anchored on a different vault ` +
                '(a vault redeploy sits between the two versions); only versions on the same vault can be compared');
        }
        if (!prior.contentSaltSeed || !prior.contentRoot || !prior.contentSchemaId) {
            return req.reject(409, `version ${prior.version} of '${row.passportId}' predates the salted-leaf release ` +
                '(no stored opening), so its content root can no longer be rebuilt');
        }
        if (!row.contentSaltSeed || !row.contentRoot) {
            return req.reject(409, `the current version of '${row.passportId}' has no stored opening; re-anchor it first`);
        }
        if (String(prior.contentSchemaId).toLowerCase() !== String(row.contentSchemaId ?? '').toLowerCase()) {
            return req.reject(409, 'the two versions were anchored under DIFFERENT provable-field schemas; ' +
                're-anchor the older one under the current layout before comparing');
        }
        if (String(prior.payloadHash).toLowerCase() === String(row.payloadHash).toLowerCase()) {
            return req.reject(400, 'both versions carry the same payload hash; a document cannot be compared with itself');
        }

        // Rebuild document A from its archived payload + stored seed, and
        // check it against the root that was actually anchored back then.
        let treeA;
        try {
            // LargeBinary arrives as Buffer, base64 string OR a stream,
            // depending on the database adapter (same trap the diligence
            // download hit), so it goes through the shared normalizer.
            const cipherA = await toBuffer(prior.payloadCipher);
            if (!cipherA?.length) throw new Error('archived payload cipher is empty');
            const payloadA = JSON.parse(decryptPayload(cipherA, String(row.passportId)));
            treeA = await buildContentRoot(provableValuesFromPayload(payloadA), { saltSeed: prior.contentSaltSeed });
        } catch (e: any) {
            return req.reject(409, `version ${prior.version} of '${row.passportId}' cannot be reopened: ${String(e?.message ?? e)}`);
        }
        if (treeA.contentRoot.toLowerCase() !== String(prior.contentRoot).toLowerCase()) {
            return req.reject(409, `the stored opening of version ${prior.version} does not reproduce its anchored ` +
                'content root, so it cannot serve as proof material');
        }
        const { tree: treeB } = await this.contentTreeFor(row.ID);
        if (treeB.contentRoot.toLowerCase() !== String(row.contentRoot).toLowerCase()) {
            return req.reject(409, `the current values of '${row.passportId}' no longer produce its anchored content ` +
                'root (drift); re-anchor before proving version integrity');
        }

        // Off-chain pre-flight of the very statement the circuit will check.
        const broken = firstUnmaskedDifference(treeA.opening.slots, treeB.opening.slots, mask);
        if (broken) {
            return req.reject(400, `'${broken}' changed between version ${prior.version} and the current version, ` +
                `but the mask does not allow it (${describeMask(mask)})`);
        }

        // The complementary LOWER bound. The mask says what may change, k says
        // how much did change; a periodic measurement update needs both to be
        // checkable ("specification untouched" alone is also true of a
        // re-timestamp that measured nothing).
        const changedSlots = countChangedSlots(treeA.opening.slots, treeB.opening.slots);
        const k = Math.max(0, Math.trunc(Number(minChangedSlots ?? 0)));
        if (k > SLOT_COUNT) return req.reject(400, `minChangedSlots must be at most ${SLOT_COUNT}`);
        if (k > changedSlots) {
            return req.reject(400, `only ${changedSlots} slot(s) differ between version ${prior.version} and the ` +
                `current version, so "at least ${k} changed" cannot be proven` +
                (changedSlots === 0 ? ' (this re-anchor changed no provable value at all)' : ''));
        }

        const session = await this.effectiveSession(sessionId, walletId);
        const contractAddress = this.vaultFor(row, sessionId);
        const claim = `versus version ${prior.version}: ${describeMask(mask)}`
            + (k > 0 ? `, and at least ${k} slot(s) did change` : '');
        const base = {
            fromVersion: Number(prior.version), allowedMask: mask,
            allowedFields: JSON.stringify(fieldsFromMask(mask)),
            minChangedSlots: k, changedSlots, claim,
            payloadHashA: String(prior.payloadHash), payloadHashB: String(row.payloadHash)
        };
        const logRowBase = {
            passport_ID: row.ID, sourceField: '', threshold: null, unit: null,
            payloadHash: String(prior.payloadHash), payloadHashB: String(row.payloadHash)
        };
        const integrityRow = { ...logRowBase, predicate: 'documentIntegrity', allowedMask: mask };
        // The diff claim's k rides in `allowedMask`: same column, different
        // predicate, and the claim kinds never share a row. Keeps the log
        // narrow instead of growing a column per cross-root variant.
        const changeRow = { ...logRowBase, predicate: 'documentDiff', allowedMask: k };
        if (!session || !contractAddress) {
            await this.runDetached(async () => {
                await INSERT.into(PredicateProofLog).entries([
                    { ...integrityRow, status: 'offline' },
                    ...(k > 0 ? [{ ...changeRow, status: 'offline' }] : [])
                ] as any);
            });
            return { mode: 'offline', proofLogId: '', changeProofLogId: '', ...base };
        }

        const proofLogId = cds.utils.uuid();
        const changeProofLogId = k > 0 ? cds.utils.uuid() : '';
        await this.runDetached(async () => {
            await INSERT.into(PredicateProofLog).entries([
                { ID: proofLogId, ...integrityRow, status: 'pending' },
                ...(k > 0 ? [{ ID: changeProofLogId, ...changeRow, status: 'pending' }] : [])
            ] as any);
        });
        const sponsorSessionId = await this.sponsorSessionIdFor(String(session), sponsorWalletId);
        // Both roots are already anchored, so no contentRootA/B rides along:
        // anchoring is insert-once and a re-anchor of the same root is at best
        // a no-op tx.
        const shared = {
            schema: JSON.parse(JSON.stringify(treeA.schema)),
            openingA: treeA.opening,
            openingB: treeB.opening,
            payloadHashB: String(row.payloadHash)
        };
        const claims = [
            { predicate: 'documentIntegrity', allowedMask: mask, ...shared },
            ...(k > 0 ? [{ predicate: 'documentDiff', k, ...shared }] : [])
        ];
        const args = {
            // Document A is the batch's payloadHash; every claim names B itself.
            payloadHash: String(prior.payloadHash),
            claimsJson: JSON.stringify(claims),
            sessionId: session, contractAddress, compiledArtifactRef: CONTRACT_REF,
            ...(sponsorSessionId ? { sponsorSessionId } : {})
        };
        const user = req.user;
        const rows = [
            { logId: proofLogId, kind: 'documentIntegrity' as const, bound: mask },
            ...(k > 0 ? [{ logId: changeProofLogId, kind: 'documentDiff' as const, bound: k }] : [])
        ];
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() => this.runIntegrityDetached(rows, String(row.ID), args, user, {
                contractAddress, payloadHashA: String(prior.payloadHash), payloadHashB: String(row.payloadHash)
            })).catch((e: unknown) =>
                cds.log('producer').error(`detached integrity runner crashed for ${row.passportId}:`, e));
        });
        return { mode: 'proving', proofLogId, changeProofLogId, ...base };
    };

    /**
     * The long-running leg of proveVersionIntegrity: one or two cross-root
     * proofs in ONE transaction (upper bound, and the optional lower bound).
     * The cross-root circuit is the vault's largest (38.5 MB of prover key),
     * so this is the slowest proof in the system and a second claim doubles
     * the proving time even though it shares the transaction; a proof server
     * beats in-process wasm noticeably here.
     */
    private async runIntegrityDetached(
        rows: Array<{ logId: string; kind: 'documentIntegrity' | 'documentDiff'; bound: number }>,
        passportRowId: string,
        args: Record<string, unknown> & { sessionId: string; contractAddress: string },
        user: unknown,
        pair: { contractAddress: string; payloadHashA: string; payloadHashB: string }
    ): Promise<void> {
        const log = cds.log('producer');
        const logIds = rows.map((r) => r.logId);
        try {
            const nightgate = await cds.connect.to('NightgateService');
            const prewarmJob = this.serverPrewarmJobs.get(args.sessionId);
            if (prewarmJob) {
                this.serverPrewarmJobs.delete(args.sessionId);
                await waitForJobResult(nightgate, prewarmJob, args.sessionId, user);
            }
            let res: any = null;
            const jobResult: any = await runChainStep('integrity proof', async () => {
                // The batch action carries both cross-root kinds, so the pair
                // of claims shares one balancing round, one submit and one fee.
                res = await sendDetached(nightgate, 'issueFieldPredicateAttestationBatch', args, user);
                // The cross-root circuit is the vault's largest (38.5 MB prover
                // key). In-process wasm proving plus submit plus confirmation
                // ran past the 10 minute default here, and the wait timing out
                // is NOT the proof failing: the transaction landed anyway
                // (measured live, tx 7698bd13…). Give it a real budget, and
                // treat a timeout as "unknown", never as "failed" (see below).
                return waitForJobResult(nightgate, res.jobId, args.sessionId, user, {
                    requireChainSuccess: true, timeoutMs: 40 * 60_000
                });
            });
            const txHash = String(jobResult?.proof?.proofValue ?? jobResult?.txHash ?? '');
            // Per-claim attestation ids from the batch response, joined by
            // claim kind (cross-root claims carry no fieldKey, so the field
            // claim join key does not apply here).
            const idByKind = new Map<string, string>();
            const collect = (c: any) => {
                const kind = String(c?.predicate ?? c?.claim?.predicate ?? '');
                if (kind && c?.predicateAttestationId) idByKind.set(kind, String(c.predicateAttestationId));
            };
            try { for (const c of JSON.parse(String(res?.claims ?? '[]'))) collect(c); } catch { /* job result below */ }
            for (const c of (Array.isArray(jobResult?.claims) ? jobResult.claims : [])) collect(c);
            await this.runDetached(async () => {
                for (const r of rows) {
                    await UPDATE.entity(PredicateProofLog).set({
                        status: 'succeeded', result: true, txHash,
                        predicateAttestationId: idByKind.get(r.kind) ?? ''
                    }).where({ ID: r.logId });
                }
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'provePredicate', jobId: res.jobId, txHash,
                    status: 'succeeded', explorerUrl: txExplorerUrl(txHash)
                } as any);
            });
            log.info(`version transition proven (${rows.map((r) => r.kind).join('+')}) for ${logIds.join(',')}: ${txHash}`);
        } catch (e) {
            // A version that changed outside the mask also lands here (the
            // circuit rejects at local proving; nothing was submitted).
            const msg = String((e as Error)?.message ?? e).slice(0, 500);
            // ... but so does a wait that simply ran out while the proof was
            // still being proven or confirmed. Marking that 'failed' would lie
            // red about a claim that IS on-chain, so ask the ledger PER CLAIM
            // before writing the verdict: each claim key is fully determined by
            // the two payload hashes plus its own bound. Asking per claim also
            // covers the ledger's PARTIAL_SUCCESS case, where one of the two
            // landed and the other did not.
            const verdicts = await Promise.all(rows.map((r) =>
                verifyCrossRootState({
                    contractAddress: pair.contractAddress,
                    payloadHashA: pair.payloadHashA,
                    payloadHashB: pair.payloadHashB,
                    kind: r.kind,
                    bound: r.bound
                }).catch(() => 'unknown' as const)));
            const proven = rows.filter((_, i) => verdicts[i] === 'confirmed');
            const open = rows.filter((_, i) => verdicts[i] !== 'confirmed');
            if (proven.length) {
                log.warn(`version transition wait ended for ${logIds.join(',')} (${msg.slice(0, 80)}), ` +
                    `but ${proven.length} of ${rows.length} claim(s) verify on-chain; recording those as proven`);
                await this.runDetached(async () => {
                    for (const r of proven) {
                        await UPDATE.entity(PredicateProofLog).set({ status: 'succeeded', result: true })
                            .where({ ID: r.logId });
                    }
                });
            }
            if (!open.length) return;
            log.warn(`version transition proof failed for ${open.map((r) => r.logId).join(',')}:`, e);
            await this.runDetached(async () => {
                for (const r of open) {
                    await UPDATE.entity(PredicateProofLog).set({ status: 'failed', result: false }).where({ ID: r.logId });
                }
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'provePredicate', status: 'failed', errorMessage: msg
                } as any);
            });
        }
    }

    /** Claim key -> predicateAttestationId from the batch action response
     *  (res.claims, JSON string) or the job result (claims array). Both sides
     *  of the join key through proof-plan's responseClaimKey. */
    /**
     * The long-running leg of provePassportValue. The field-bound proof job
     * submits TWO txs (anchorContentRoot, then proveFieldPredicate); the job
     * result is a PAC envelope whose tx hash sits at `proof.proofValue`. The
     * content-root tx hash is not in the result at all, so it is read back
     * from the plugin's `midnight.PendingSubmissions` log.
     */
    private async runProveDetached(
        proofLogId: string, passportRowId: string,
        args: Record<string, unknown> & { sessionId: string; contractAddress: string },
        user: unknown
    ): Promise<void> {
        const log = cds.log('producer');
        const startedAt = new Date().toISOString();
        try {
            const nightgate = await cds.connect.to('NightgateService');
            // First action on a fresh server session: await the facade prewarm
            // once, same as the anchor runner.
            const prewarmJob = this.serverPrewarmJobs.get(args.sessionId);
            if (prewarmJob) {
                this.serverPrewarmJobs.delete(args.sessionId);
                await waitForJobResult(nightgate, prewarmJob, args.sessionId, user);
            }
            // Same 1014 retry as the anchor steps and the cart (see there).
            let res: any = null;
            const jobResult: any = await runChainStep('proof', async () => {
                res = await sendDetached(nightgate, 'issueFieldPredicateAttestation', args, user);
                return waitForJobResult(
                    nightgate, res.jobId, args.sessionId, user, { requireChainSuccess: true }
                );
            });
            const txHash = String(jobResult?.proof?.proofValue ?? jobResult?.txHash ?? '');
            const paId = String(res.predicateAttestationId ?? jobResult?.predicateAttestationId ?? '');
            const rootTx = await this.contentRootTxOf(args.sessionId, args.contractAddress, startedAt);
            await this.runDetached(async () => {
                await UPDATE.entity(PredicateProofLog).set({
                    status: 'succeeded', result: true, txHash, predicateAttestationId: paId
                }).where({ ID: proofLogId });
                if (rootTx) {
                    // Stamp the row with the tx's real submit time: both proof
                    // rows are inserted together here, and identical createdAt
                    // values make the (root, prove) pair sort randomly.
                    await INSERT.into(PassportTransactions).entries({
                        passport_ID: passportRowId, kind: 'anchorContentRoot', jobId: res.jobId,
                        txHash: rootTx.txHash, status: 'succeeded', explorerUrl: txExplorerUrl(rootTx.txHash),
                        ...(rootTx.submittedAt ? { createdAt: rootTx.submittedAt } : {})
                    } as any);
                }
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'provePredicate', jobId: res.jobId, txHash,
                    status: 'succeeded', explorerUrl: txExplorerUrl(txHash)
                } as any);
            });
            log.info(`predicate proven for log ${proofLogId}: ${txHash}`);
        } catch (e) {
            // A rejected predicate (value fails the bound) also lands here.
            const msg = String((e as Error)?.message ?? e).slice(0, 500);
            log.warn(`predicate proof failed for log ${proofLogId}:`, e);
            await this.runDetached(async () => {
                await UPDATE.entity(PredicateProofLog).set({ status: 'failed', result: false }).where({ ID: proofLogId });
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'provePredicate', status: 'failed', errorMessage: msg
                } as any);
            });
        }
    }

    /**
     * Upload a due-diligence evidence file and anchor its sha256 on-chain via
     * NIGHTGATE anchorDocument (an own attest tx; the passport payloadHash is
     * untouched, the document carries its own anchor). Bytes stay off-chain in
     * the DiligenceDoc row. Without a session/contract the file is stored as
     * 'offline'. The chain leg runs DETACHED after commit; clients poll the row.
     */
    private uploadDiligenceDoc = async (req: cds.Request) => {
        const { passportId, docType, fileName, mimeType, contentBase64, sessionId, walletId, sponsorWalletId } =
            req.data as {
                passportId?: string; docType?: string; fileName?: string; mimeType?: string;
                contentBase64?: string; sessionId?: string; walletId?: string; sponsorWalletId?: string;
            };
        if (!passportId) return req.reject(400, 'passportId is required');
        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'contractAddress').where({ passportId });
        if (!row) return req.reject(404, `passport ${passportId} not found`);

        const bytes = decodeUpload(String(contentBase64 ?? ''));
        if (!bytes) return req.reject(400, 'contentBase64 is missing or not valid base64');
        const check = validateDiligenceUpload(String(fileName ?? ''), String(mimeType ?? ''), bytes.length);
        if (!check.ok) return req.reject(400, check.error as string);
        const sha256 = sha256Hex(bytes);

        const session = await this.effectiveSession(sessionId, walletId);
        const contractAddress = this.vaultFor(row, sessionId);
        const docId = cds.utils.uuid();
        const mode = session && contractAddress ? 'anchoring' : 'offline';
        await INSERT.into(DiligenceDoc).entries({
            ID: docId, passport_ID: row.ID,
            docType: docType || 'supply-chain-due-diligence-report',
            fileName, mimeType, fileSize: bytes.length, sha256, content: bytes,
            status: mode === 'anchoring' ? 'pending' : 'offline'
        } as any);
        if (mode === 'offline') return { docId, sha256, mode };

        const sponsorSessionId = await this.sponsorSessionIdFor(String(session), sponsorWalletId);
        const args = {
            sha256, contentType: String(mimeType), size: bytes.length,
            storageRef: `passport-diligence://${passportId}/${docId}`,
            sessionId: String(session), contractAddress: String(contractAddress), compiledArtifactRef: CONTRACT_REF,
            ...(sponsorSessionId ? { sponsorSessionId } : {})
        };
        const user = req.user;
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() =>
                this.runDiligenceAnchorDetached(docId, String(row.ID), args, user)
            ).catch((e: unknown) =>
                cds.log('producer').error(`detached diligence anchor crashed for ${passportId}:`, e));
        });
        return { docId, sha256, mode };
    };

    /** The long-running leg of uploadDiligenceDoc (single anchorDocument tx). */
    private async runDiligenceAnchorDetached(
        docId: string, passportRowId: string,
        args: Record<string, unknown> & { sessionId: string; contractAddress: string },
        user: unknown
    ): Promise<void> {
        const log = cds.log('producer');
        try {
            const nightgate = await cds.connect.to('NightgateService');
            // First action on a fresh server session: await the facade prewarm
            // once, same as the anchor and prove runners.
            const prewarmJob = this.serverPrewarmJobs.get(args.sessionId);
            if (prewarmJob) {
                this.serverPrewarmJobs.delete(args.sessionId);
                await waitForJobResult(nightgate, prewarmJob, args.sessionId, user);
            }
            const res: any = await sendDetached(nightgate, 'anchorDocument', args, user);
            const jobResult: any = await waitForJobResult(
                nightgate, res.jobId, args.sessionId, user, { requireChainSuccess: true }
            );
            const txHash = norm(String(jobResult?.txHash ?? ''));
            await this.runDetached(async () => {
                await UPDATE.entity(DiligenceDoc).set({
                    status: 'succeeded', anchorTxHash: txHash,
                    ...(res.documentId ? { documentRef_ID: String(res.documentId) } : {})
                } as any).where({ ID: docId });
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'anchorDoc', jobId: String(res.jobId ?? ''),
                    txHash, status: 'succeeded', explorerUrl: txExplorerUrl(txHash)
                } as any);
            });
            log.info(`diligence doc ${docId} anchored: ${txHash}`);
        } catch (e) {
            const msg = String((e as Error)?.message ?? e).slice(0, 500);
            log.warn(`diligence doc anchor failed for ${docId}:`, e);
            await this.runDetached(async () => {
                await UPDATE.entity(DiligenceDoc).set({ status: 'failed' } as any).where({ ID: docId });
                await INSERT.into(PassportTransactions).entries({
                    passport_ID: passportRowId, kind: 'anchorDoc', status: 'failed', errorMessage: msg
                } as any);
            });
        }
    }

    /** Cockpit download of an uploaded due-diligence file (producer-gated). */
    private diligenceFile = async (req: cds.Request) => {
        const { docId } = req.data as { docId?: string };
        if (!docId) return req.reject(400, 'docId is required');
        const row: any = await SELECT.one.from(DiligenceDoc)
            .columns('ID', 'fileName', 'mimeType', 'content').where({ ID: docId });
        if (!row?.content) return req.reject(404, `no uploaded file for document ${docId}`);
        const buf = await toBuffer(row.content);
        if (!buf?.length) return req.reject(404, `no uploaded file for document ${docId}`);
        return {
            fileName: String(row.fileName ?? 'document'),
            mimeType: String(row.mimeType ?? 'application/octet-stream'),
            contentBase64: buf.toString('base64')
        };
    };

    /**
     * Re-anchor a passport onto a freshly computed payload hash (re-anchoring
     * policy). The current anchor is archived as a PassportAnchorVersions row
     * (including its cipher, so the old canonical payload stays decryptable),
     * the row moves to the new hash + cipher, and the standard anchorRow flow
     * runs the on-chain leg (attest of the new hash + bindPassport RE-BIND of
     * the same passportIdHash + fresh content root, one batched tx, detached).
     * The vault allows the re-bind only for the attester holding the current
     * binding, so this MUST run with the same wallet that anchored before; a
     * foreign wallet fails on-chain with a clean 'failed' status.
     */
    private reanchorPassport = async (req: cds.Request) => {
        const { passportId, reason, sessionId, walletId, sponsorWalletId } = req.data as {
            passportId?: string; reason?: string; sessionId?: string; walletId?: string; sponsorWalletId?: string;
        };
        const pid = String(passportId ?? '').trim();
        if (!pid) return req.reject(400, 'passportId is required');
        const REASONS = ['status-change', 'batch-telemetry', 'data-correction'];
        const why = REASONS.includes(String(reason)) ? String(reason) : 'data-correction';

        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'owner', 'payloadHash', 'payloadCipher', 'passportIdHash',
                'contractAddress', 'anchorNetwork', 'attestationTxHash', 'status')
            .where({ passportId: pid });
        if (!row) return req.reject(404, `passport '${pid}' not found`);

        const versionRows: any[] = await SELECT.from(PassportAnchorVersions)
            .columns('version').where({ passport_ID: row.ID });
        let maxVersion = 0;
        for (const v of versionRows ?? []) maxVersion = Math.max(maxVersion, Number(v.version ?? 0));

        if (row.status !== 'anchored' && !(row.status === 'failed' && maxVersion > 0)) {
            return req.reject(400,
                `passport '${pid}' is '${row.status}'; re-anchoring needs an anchored passport ` +
                `(drafts and first-anchor failures go through submitPassport)`);
        }
        const contractAddress = this.vaultFor(row, sessionId);
        const session = await this.effectiveSession(sessionId, walletId);
        if (!session || !contractAddress) {
            return req.reject(400, 're-anchoring is an on-chain operation; no signing session / PASSPORT_CONTRACT_ADDRESS available');
        }
        // Owner scope applies to the registry-wallet path only: an explicit
        // sessionId means an external signer (browser wallet, demo tester),
        // and there the vault's attester check IS the enforcement.
        if (!sessionId) this.assertWalletOwnsPassport(req, row, walletId);

        const core = await this.reanchorCore(req, row, why, session, contractAddress, sponsorWalletId);
        return { passportId: pid, ...core };
    };

    /**
     * Best-effort authorization for content-changing on-chain operations: when
     * the passport carries an owner (shielded address) and a SERVER wallet is
     * chosen, that wallet's registry owner must match. Catches wrong-wallet
     * mistakes early with a clean 403; the hard enforcement stays on-chain
     * (only the attester holding the current binding can re-bind).
     */
    private assertWalletOwnsPassport(req: cds.Request, row: { owner?: string | null; passportId?: string }, walletId?: string): void {
        const owner = String(row.owner ?? '').trim();
        if (!owner) return;
        const wallet = listProducerWallets().find((w) => w.id === (walletId?.trim() || 'default'));
        if (!wallet?.owner) return;
        if (wallet.owner !== owner) {
            req.reject(403, `wallet '${wallet.id}' does not own passport '${row.passportId}' (owner scope mismatch)`);
        }
    }

    /**
     * Shared re-anchor core (used by reanchorPassport and changeBatteryStatus):
     * recompute the v2 payload from the CURRENT database state, archive the
     * live anchor as a version row, move the row onto the new hash + cipher,
     * and run the standard anchorRow flow. Caller has already validated row
     * eligibility, session, contract, and ownership.
     */
    private async reanchorCore(
        req: cds.Request, row: any, why: string,
        session: string, contractAddress: string, sponsorWalletId?: string
    ) {
        const pid = String(row.passportId);
        const versionRows: any[] = await SELECT.from(PassportAnchorVersions)
            .columns('version').where({ passport_ID: row.ID });
        let maxVersion = 0;
        for (const v of versionRows ?? []) maxVersion = Math.max(maxVersion, Number(v.version ?? 0));

        const inputs = await readPayloadInputs(String(row.ID));
        const { canonicalPayload, payloadHash: newHash } = hashPayload(payloadFromDb(inputs));

        let archivedVersion = 0;
        if (row.status === 'anchored') {
            if (newHash === row.payloadHash) return req.reject(400, `content of '${pid}' is unchanged since its last anchor`);
            // Archive the live anchor before the row moves on. anchoredAt is
            // best effort from the newest succeeded attest step.
            const lastAttest: any = await SELECT.one.from(PassportTransactions)
                .columns('createdAt').where({ passport_ID: row.ID, kind: 'attest', status: 'succeeded' })
                .orderBy('createdAt desc' as any);
            archivedVersion = maxVersion + 1;
            // Read the outgoing version's content-tree coordinates HERE rather
            // than trusting the caller's column list: the salt seed is what
            // keeps this version usable in a cross-root comparison later. Lose
            // it on archive and the version can still be verified as anchored,
            // but never compared against its successor again.
            const live: any = await SELECT.one.from(Passports)
                .columns('contentRoot', 'contentSchemaId', 'contentSaltSeed').where({ ID: row.ID });
            await INSERT.into(PassportAnchorVersions).entries({
                passport_ID: row.ID, version: archivedVersion,
                payloadHash: row.payloadHash, payloadCipher: row.payloadCipher,
                contentRoot: live?.contentRoot ?? null,
                contentSchemaId: live?.contentSchemaId ?? null,
                contentSaltSeed: live?.contentSaltSeed ?? null,
                contractAddress: row.contractAddress, anchorNetwork: row.anchorNetwork,
                attestationTxHash: row.attestationTxHash,
                anchoredAt: lastAttest?.createdAt ?? null, reason: why
            } as any);
        }
        // Failed re-anchor retry: the row already carries the (never-anchored)
        // new hash; recompute may match it, which is fine, we just anchor again.
        if (newHash !== row.payloadHash) {
            const payloadCipher = encryptPayload(canonicalPayload, pid);
            await UPDATE.entity(Passports).set({ payloadHash: newHash, payloadCipher: payloadCipher as any }).where({ ID: row.ID });
        }

        // Active local grants: on-chain disclosure grants are keyed by payload
        // hash, so they do NOT carry over to the new version. The operator
        // decides which to re-issue (no silent chain spend here).
        const grantRows: any[] = await SELECT.from(DisclosureGrantLog)
            .columns('grantee', 'level', 'op', 'createdAt')
            .where({ passport_ID: row.ID, status: { in: ['succeeded', 'pending'] } })
            .orderBy('createdAt' as any);
        const latestByGrantee = new Map<string, { grantee: string; level: number; op: string }>();
        for (const g of grantRows ?? []) latestByGrantee.set(String(g.grantee), { grantee: String(g.grantee), level: Number(g.level ?? 0), op: String(g.op) });
        const grantsToRegrant = [...latestByGrantee.values()]
            .filter((g) => g.op === 'grant')
            .map(({ grantee, level }) => ({ grantee, level }));

        const r = await this.anchorRow(req, String(row.ID), pid, newHash, String(row.passportIdHash), contractAddress, session, true, sponsorWalletId);
        return {
            archivedVersion,
            payloadHash: newHash, previousPayloadHash: String(row.payloadHash ?? ''),
            contentRoot: (r as any).contentRoot ?? '', mode: (r as any).mode ?? 'anchoring',
            grantsToRegrant
        };
    }

    /**
     * Battery status lifecycle transition. The ONLY write path for the
     * BatteryStatus attribute row (excluded from the telemetry allowlist).
     * Always writes locally first (row + lifecycle history + modifiedAt);
     * anchored passports with a signing session re-anchor immediately with
     * reason 'status-change' (policy). Without a session the change lands as
     * drift and the next re-anchor (manual or batch) commits it on-chain.
     */
    private changeBatteryStatus = async (req: cds.Request) => {
        const { passportId, newStatus, sessionId, walletId, sponsorWalletId } = req.data as {
            passportId?: string; newStatus?: string; sessionId?: string; walletId?: string; sponsorWalletId?: string;
        };
        const pid = String(passportId ?? '').trim();
        if (!pid) return req.reject(400, 'passportId is required');

        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'owner', 'payloadHash', 'payloadCipher', 'passportIdHash',
                'contractAddress', 'anchorNetwork', 'attestationTxHash', 'status', 'createdAt')
            .where({ passportId: pid });
        if (!row) return req.reject(404, `passport '${pid}' not found`);

        const statusRow: any = await SELECT.one.from(PassportAttributes)
            .columns('ID', 'section', 'attribute', 'valueJson', 'accessClass')
            .where({ passport_ID: row.ID, attribute: 'BatteryStatus' });
        if (!statusRow) return req.reject(404, `passport '${pid}' has no BatteryStatus attribute row`);

        const previousStatus = parseBatteryStatus(statusRow.valueJson);
        const check = validateTransition(previousStatus, newStatus);
        if (!check.ok) return req.reject(400, check.error);
        // Registry-wallet path only; explicit sessions are enforced on-chain
        // (same rule as reanchorPassport).
        if (!sessionId) this.assertWalletOwnsPassport(req, row, walletId);

        await this.writeAttributeVersions(row, [
            { row: statusRow, valueJson: encodeBatteryStatus(newStatus as BatteryStatus) }
        ], 'lifecycle');

        // Draft passports just carry the new status into their eventual first
        // anchor; anchored ones re-anchor now (or drift until the next one).
        if (row.status !== 'anchored') {
            return { passportId: pid, previousStatus, newStatus, mode: 'draft', archivedVersion: 0, payloadHash: '', grantsToRegrant: [] };
        }
        const contractAddress = this.vaultFor(row, sessionId);
        const session = await this.effectiveSession(sessionId, walletId);
        if (!session || !contractAddress) {
            cds.log('producer').warn(`status change of '${pid}' recorded WITHOUT re-anchor (no session/contract); content is now drifted`);
            return { passportId: pid, previousStatus, newStatus, mode: 'offline', archivedVersion: 0, payloadHash: '', grantsToRegrant: [] };
        }
        const core = await this.reanchorCore(req, row, 'status-change', session, contractAddress, sponsorWalletId);
        return {
            passportId: pid, previousStatus, newStatus,
            mode: (core as any).mode, archivedVersion: (core as any).archivedVersion,
            payloadHash: (core as any).payloadHash, grantsToRegrant: (core as any).grantsToRegrant
        };
    };

    /** walletId -> derived attesterId; deriveWalletInfo shares the rate-limited
     *  secret path with session opening, so each id is derived at most once. */
    private attesterIdCache = new Map<string, string>();

    /**
     * The attester identity of a registry wallet (registerPassport's ownerId):
     * env cache (PRODUCER_<ID>_ATTESTER_ID) first, then a one-time
     * deriveWalletInfo call memoized for the process lifetime.
     */
    private async attesterIdFor(req: cds.Request, walletId: string): Promise<string> {
        const secrets = producerWalletSecrets(walletId);
        if (!secrets) { req.reject(400, `unknown or secret-less target wallet '${walletId}'`); return ''; }
        if (secrets.attesterId) return secrets.attesterId;
        const cached = this.attesterIdCache.get(secrets.id);
        if (cached) return cached;
        const nightgate = await cds.connect.to('NightgateService');
        const info: any = await (nightgate as any).send('deriveWalletInfo', { mnemonic: secrets.mnemonic });
        const attesterId = String(info?.attesterId ?? '');
        if (!/^[0-9a-f]{64}$/i.test(attesterId)) {
            req.reject(502, `deriveWalletInfo returned no attesterId for wallet '${secrets.id}' (NIGHTGATE >= 0.10.1 required)`);
            return '';
        }
        this.attesterIdCache.set(secrets.id, attesterId);
        return attesterId;
    }

    /**
     * Initial on-chain claim of the passport id: the registrar registers the
     * passportIdHash to the ACTING wallet's attester identity, before or
     * independent of anchoring (drafts are the main case; an unclaimed id
     * binds first-come-first-served until someone claims it). Same registrar
     * plumbing as the operator handover, without the owner flip.
     */
    private claimPassportId = async (req: cds.Request) => {
        const { passportId, walletId, sponsorWalletId } = req.data as {
            passportId?: string; walletId?: string; sponsorWalletId?: string;
        };
        const pid = String(passportId ?? '').trim();
        if (!pid) return req.reject(400, 'passportId is required');
        const wid = String(walletId ?? '').trim() || 'default';

        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'passportIdHash', 'owner', 'status', 'contractAddress')
            .where({ passportId: pid });
        if (!row) return req.reject(404, `passport '${pid}' not found`);
        this.assertWalletOwnsPassport(req, row, wid);

        const contractAddress = this.vaultFor(row);
        if (!contractAddress) return req.reject(400, 'no PASSPORT_CONTRACT_ADDRESS available');
        const registrarId = process.env.PASSPORT_REGISTRAR_WALLET?.trim() || 'default';
        const regSession = await this.serverSigningSession(registrarId);
        if (!regSession) {
            return req.reject(400, `claiming needs the registrar wallet's signing session ('${registrarId}', PASSPORT_REGISTRAR_WALLET); none available`);
        }
        const attesterId = await this.attesterIdFor(req, wid);

        // Idempotence guard: the newest settled registration already points at
        // this attester = nothing to do (the circuit overwrite is idempotent,
        // this just saves the pointless transaction).
        const last: any = await SELECT.one.from(PassportTransactions)
            .columns('identifier', 'status')
            .where({ passport_ID: row.ID, kind: 'registerPassport', status: 'succeeded' })
            .orderBy('createdAt desc' as any);
        if (last && String(last.identifier) === attesterId) {
            return req.reject(400, `passport '${pid}' is already claimed by wallet '${wid}'`);
        }

        const sponsorSessionId = await this.sponsorSessionIdFor(regSession, sponsorWalletId);
        const txRowId = cds.utils.uuid();
        await INSERT.into(PassportTransactions).entries({
            ID: txRowId, passport_ID: row.ID, kind: 'registerPassport',
            identifier: attesterId, status: 'pending'
        } as any);

        const args = {
            passportId: String(row.passportIdHash ?? '') || blake2b256Hex(pid),
            ownerId: attesterId,
            sessionId: regSession, contractAddress,
            ...(sponsorSessionId ? { sponsorSessionId } : {})
        };
        const user = req.user;
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() =>
                this.runRegisterDetached(txRowId, String(row.ID), pid, args, user, { what: 'id claim' })
            ).catch((e: unknown) =>
                cds.log('producer').error(`detached passport claim crashed for ${pid}:`, e));
        });
        return { passportId: pid, walletId: wid, ownerAttesterId: attesterId, mode: 'claiming' };
    };

    /**
     * Operator handover: on-chain registrar re-registration of the passport id
     * to the new operator's attester identity, then the local owner flip. See
     * producer-service.cds for the contract; the old operator loses the
     * in-circuit bind right the moment the registration lands, and the server
     * side owner guard the moment the owner flips.
     */
    private transferPassportOperator = async (req: cds.Request) => {
        const { passportId, newWalletId, sponsorWalletId } = req.data as {
            passportId?: string; newWalletId?: string; sponsorWalletId?: string;
        };
        const pid = String(passportId ?? '').trim();
        if (!pid) return req.reject(400, 'passportId is required');
        const targetId = String(newWalletId ?? '').trim();
        if (!targetId) return req.reject(400, 'newWalletId is required');

        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'passportIdHash', 'owner', 'status', 'contractAddress')
            .where({ passportId: pid });
        if (!row) return req.reject(404, `passport '${pid}' not found`);

        const target = producerWalletSecrets(targetId);
        if (!target) return req.reject(400, `unknown or secret-less target wallet '${targetId}'`);
        if (!target.owner) return req.reject(400, `target wallet '${targetId}' has no shielded address configured (PRODUCER_${targetId.toUpperCase()}_SHIELDED_ADDRESS)`);
        if (row.owner && row.owner === target.owner) return req.reject(400, `passport '${pid}' already belongs to wallet '${targetId}'`);

        // Active local grants: per-version on-chain, so the new operator
        // re-issues them after their first re-anchor (existing flow).
        const grantRows: any[] = await SELECT.from(DisclosureGrantLog)
            .columns('grantee', 'level', 'op', 'createdAt')
            .where({ passport_ID: row.ID, status: { in: ['succeeded', 'pending'] } })
            .orderBy('createdAt' as any);
        const latestByGrantee = new Map<string, { grantee: string; level: number; op: string }>();
        for (const g of grantRows ?? []) latestByGrantee.set(String(g.grantee), { grantee: String(g.grantee), level: Number(g.level ?? 0), op: String(g.op) });
        const activeGrants = [...latestByGrantee.values()].filter((g) => g.op === 'grant').map(({ grantee, level }) => ({ grantee, level }));

        // Drafts never touched the chain: the owner flip alone is the handover.
        if (row.status !== 'anchored') {
            await UPDATE.entity(Passports).set({ owner: target.owner }).where({ ID: row.ID });
            return {
                passportId: pid, previousOwner: String(row.owner ?? ''), newOwner: target.owner,
                newOwnerAttesterId: '', mode: 'local', activeGrants
            };
        }

        // Anchored: the handover IS an on-chain operation (registrar-only).
        const contractAddress = this.vaultFor(row);
        if (!contractAddress) return req.reject(400, 'no PASSPORT_CONTRACT_ADDRESS available');
        const registrarId = process.env.PASSPORT_REGISTRAR_WALLET?.trim() || 'default';
        const regSession = await this.serverSigningSession(registrarId);
        if (!regSession) {
            return req.reject(400, `operator handover needs the registrar wallet's signing session ('${registrarId}', PASSPORT_REGISTRAR_WALLET); none available`);
        }
        const attesterId = await this.attesterIdFor(req, targetId);
        const sponsorSessionId = await this.sponsorSessionIdFor(regSession, sponsorWalletId);

        const txRowId = cds.utils.uuid();
        await INSERT.into(PassportTransactions).entries({
            ID: txRowId, passport_ID: row.ID, kind: 'registerPassport',
            identifier: attesterId, status: 'pending'
        } as any);

        const args = {
            passportId: String(row.passportIdHash), ownerId: attesterId,
            sessionId: regSession, contractAddress,
            ...(sponsorSessionId ? { sponsorSessionId } : {})
        };
        const previousOwner = String(row.owner ?? '');
        const newOwner = target.owner;
        const user = req.user;
        (req as any).on('succeeded', () => {
            void detachedFromRequest(() =>
                this.runRegisterDetached(txRowId, String(row.ID), pid, args, user, { what: 'operator transfer', newOwner })
            ).catch((e: unknown) =>
                cds.log('producer').error(`detached operator transfer crashed for ${pid}:`, e));
        });
        return { passportId: pid, previousOwner, newOwner, newOwnerAttesterId: attesterId, mode: 'transferring', activeGrants };
    };

    /**
     * The long-running registrar leg shared by claimPassportId and
     * transferPassportOperator: one registerPassport tx, settled into the
     * PassportTransactions row. The transfer additionally flips the owner
     * scope on chain success (`newOwner`); the claim leaves it untouched.
     */
    private async runRegisterDetached(
        txRowId: string, passportRowId: string, passportId: string,
        args: Record<string, unknown> & { sessionId: string },
        user: unknown, opts: { what: string; newOwner?: string }
    ): Promise<void> {
        const log = cds.log('producer');
        try {
            const nightgate = await cds.connect.to('NightgateService');
            const prewarmJob = this.serverPrewarmJobs.get(args.sessionId);
            if (prewarmJob) {
                this.serverPrewarmJobs.delete(args.sessionId);
                await waitForJobResult(nightgate, prewarmJob, args.sessionId, user);
            }
            const res: any = await sendDetached(nightgate, 'registerPassport', args, user);
            const jobResult: any = await waitForJobResult(
                nightgate, String(res.jobId), args.sessionId, user, { requireChainSuccess: true }
            );
            const txHash = norm(String(jobResult?.txHash ?? ''));
            await this.runDetached(async () => {
                // Owner flips ONLY on chain success: until then the previous
                // operator remains the owner in every server-side check.
                if (opts.newOwner) {
                    await UPDATE.entity(Passports).set({ owner: opts.newOwner }).where({ ID: passportRowId });
                }
                await UPDATE.entity(PassportTransactions).set({
                    status: 'succeeded', txHash, explorerUrl: txExplorerUrl(txHash)
                } as any).where({ ID: txRowId });
            });
            log.info(`passport ${passportId} ${opts.what} registered on-chain (register tx ${txHash})`);
        } catch (e) {
            const msg = String((e as Error)?.message ?? e).slice(0, 500);
            log.warn(`${opts.what} failed for ${passportId}:`, e);
            await this.runDetached(async () => {
                await UPDATE.entity(PassportTransactions).set({ status: 'failed', errorMessage: msg } as any).where({ ID: txRowId });
            }).catch(() => { /* best effort */ });
        }
    }

    /** Drift check: current DB content vs the anchored hash (projection v2). */
    private passportDrift = async (req: cds.Request) => {
        const { passportId } = req.data as { passportId?: string };
        const pid = String(passportId ?? '').trim();
        if (!pid) return req.reject(400, 'passportId is required');
        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'payloadHash', 'status').where({ passportId: pid });
        if (!row) return req.reject(404, `passport '${pid}' not found`);
        const inputs = await readPayloadInputs(String(row.ID));
        const recomputedHash = hashPayload(payloadFromDb(inputs)).payloadHash;
        return {
            passportId: pid, status: String(row.status ?? ''),
            drifted: row.status === 'anchored' && recomputedHash !== row.payloadHash,
            currentHash: String(row.payloadHash ?? ''), recomputedHash
        };
    };

    /**
     * Dynamic (telemetry / SoH) attribute update: validates the batch against
     * the allowlist, appends version history (with a lazy version-0 baseline of
     * the creation-time value), updates the current rows in place and bumps the
     * passport's modifiedAt (which feeds Date-timeOfLatestUpdateOfDPP). All in
     * the ambient request tx, so the batch is atomic. Never touches payloadHash
     * or the anchor; the chain keeps the creation-time snapshot.
     */
    private updateDynamicAttributes = async (req: cds.Request) => {
        const { passportId, updatesJson, source } = req.data as
            { passportId?: string; updatesJson?: string; source?: string };
        const pid = String(passportId ?? '').trim();
        if (!pid) return req.reject(400, 'passportId is required');
        const src = source === 'bms' ? 'bms' : 'api';

        let parsed: unknown;
        try { parsed = JSON.parse(String(updatesJson ?? '')); }
        catch { return req.reject(400, 'updatesJson must be valid JSON'); }
        if (!Array.isArray(parsed) || !parsed.length) {
            return req.reject(400, 'updatesJson must be a non-empty array of { attribute, value }');
        }
        if (parsed.length > 100) return req.reject(400, 'too many updates in one batch (max 100)');
        const shaped = parsed.filter((u): u is DynamicUpdate =>
            !!u && typeof u === 'object' && typeof (u as any).attribute === 'string');
        if (shaped.length !== parsed.length) {
            return req.reject(400, 'every update must be an object with a string `attribute`');
        }
        const updates = dedupeUpdates(shaped);

        const passport: any = await SELECT.one.from(Passports).columns('ID', 'createdAt').where({ passportId: pid });
        if (!passport) return req.reject(404, `passport '${pid}' not found`);

        const names = updates.map((u) => u.attribute);
        const currentRows: any[] = await SELECT.from(PassportAttributes)
            .columns('ID', 'section', 'attribute', 'valueJson', 'accessClass')
            .where({ passport_ID: passport.ID, attribute: { in: names } });
        const currentByName = new Map(currentRows.map((r) => [r.attribute, r]));

        // Validate everything before writing anything (atomic all-or-nothing).
        const encoded: Array<{ row: any; valueJson: string }> = [];
        for (const u of updates) {
            if (!DYNAMIC_ATTRIBUTES[u.attribute]) return req.reject(400, `attribute is not updatable: ${u.attribute}`);
            const row = currentByName.get(u.attribute);
            if (!row) return req.reject(400, `attribute not present on passport '${pid}': ${u.attribute}`);
            const enc = encodeDynamicValue(u.attribute, u.value);
            if (!enc.ok) return req.reject(400, enc.error);
            encoded.push({ row, valueJson: enc.valueJson });
        }

        const results = await this.writeAttributeVersions(passport, encoded, src);
        return { passportId: pid, updated: encoded.length, results };
    };

    /**
     * Append version history for a batch of attribute updates and apply them to
     * the current rows (shared by the telemetry and lifecycle write paths):
     * lazy version-0 baseline on an attribute's first update, ONE receipt time
     * per batch (ordering within it is carried by `version`; no caller-supplied
     * backdating, audit integrity), in-place current-row update, and a
     * modifiedAt bump so Date-timeOfLatestUpdateOfDPP moves with the data.
     * Runs in the caller's ambient tx, so the batch stays atomic.
     */
    private async writeAttributeVersions(
        passport: { ID: string; createdAt?: string },
        encoded: Array<{ row: any; valueJson: string }>,
        source: string
    ): Promise<Array<{ attribute: string; version: number; validFrom: string }>> {
        const names = encoded.map((e) => String(e.row.attribute));
        const histRows: any[] = await SELECT.from(PassportAttributeHistory)
            .columns('attribute', 'version')
            .where({ passport_ID: passport.ID, attribute: { in: names } });
        const maxVersion = new Map<string, number>();
        for (const h of histRows) {
            maxVersion.set(h.attribute, Math.max(maxVersion.get(h.attribute) ?? -1, Number(h.version)));
        }

        const now = new Date().toISOString();
        const historyEntries: any[] = [];
        const results: Array<{ attribute: string; version: number; validFrom: string }> = [];
        for (const { row, valueJson } of encoded) {
            const prev = maxVersion.get(row.attribute);
            if (prev == null) {
                historyEntries.push({
                    passport_ID: passport.ID, section: row.section, attribute: row.attribute,
                    valueJson: row.valueJson, accessClass: row.accessClass,
                    version: 0, validFrom: passport.createdAt, source: 'baseline'
                });
            }
            const version = (prev ?? 0) + 1;
            historyEntries.push({
                passport_ID: passport.ID, section: row.section, attribute: row.attribute,
                valueJson, accessClass: row.accessClass,
                version, validFrom: now, source
            });
            results.push({ attribute: row.attribute, version, validFrom: now });
        }

        await INSERT.into(PassportAttributeHistory).entries(historyEntries);
        for (const { row, valueJson } of encoded) {
            await UPDATE.entity(PassportAttributes).set({ valueJson }).where({ ID: row.ID });
        }
        // Bump the aggregate so Date-timeOfLatestUpdateOfDPP moves with the data.
        await UPDATE.entity(Passports).set({ modifiedAt: now } as any).where({ ID: passport.ID });
        return results;
    }

    /**
     * The content-root anchor tx of the proof job just completed: the newest
     * `anchorContentRoot` submission of this session/contract since the job
     * started, from the plugin's own submission log. Best-effort (null if the
     * lookup fails); the proof tx itself never depends on it.
     */
    private async contentRootTxOf(sessionId: string, contractAddress: string, sinceIso: string):
        Promise<{ txHash: string; submittedAt?: string } | null> {
        try {
            const rows: any[] = await cds.db.read('midnight.PendingSubmissions')
                .columns('txHash', 'submittedAt')
                .where({ sessionId, contractAddress, circuitName: 'anchorContentRoot' })
                .and('submittedAt >=', sinceIso)
                .orderBy('submittedAt desc')
                .limit(1);
            const hit = rows?.[0];
            return hit?.txHash ? { txHash: hit.txHash, submittedAt: hit.submittedAt } : null;
        } catch (e) {
            cds.log('producer').warn('content-root tx lookup skipped:', (e as Error)?.message);
            return null;
        }
    }
}
