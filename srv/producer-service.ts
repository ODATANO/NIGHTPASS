import cds from '@sap/cds';
import {
    Passports, Batteries, RecycledMaterials, DiligenceDoc,
    PassportTransactions, DisclosureGrantLog, PredicateProofLog
} from '#cds-models/passport';
import {
    hashPayload, blake2b256Hex, encryptPayload, anchorPassport, waitForJob, waitForJobResult,
    detachedFromRequest, sendDetached,
    buildContentRoot, fieldKeyHex, BATTERY_PROVABLE_FIELDS,
    effectiveNetwork, explorerTxUrl
} from './lib/passport-anchor';
import { defaultGuideAttributes, hashableAttributes } from './lib/guide-attribute-defaults';
import { listProducerWallets, producerWalletSecrets, feeSponsorWalletId, feeSponsorWalletIds } from './lib/producer-wallets';
import { verifyContractTx, type ChainVerdict } from './lib/chain-verify';
import { verifyAttestState, verifyGrantState, verifyPredicateState } from './lib/state-verify';

const CONTRACT_REF = 'attestation-vault';

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
        this.on('prewarmServerWallet', this.prewarmServerWallet);
        this.on('serverWalletStatus', this.serverWalletStatus);
        this.on('sponsorPoolStatus', this.sponsorPoolStatus);
        this.on('recordWalletAttest', this.recordWalletAttest);
        this.on('recordWalletDisclosure', this.recordWalletDisclosure);
        this.on('recordWalletPredicate', this.recordWalletPredicate);
        this.on('passportFieldValue', this.passportFieldValue);
        this.on('validatePassportConformance', this.validatePassportConformance);
        this.on('publishPassport', this.publishPassport);
        this.on('passportAspectJson', this.passportAspectJson);
        this.on('passportCredential', this.passportCredential);
        this.on('grantPassportDisclosure', this.grantPassportDisclosure);
        this.on('revokePassportDisclosure', this.revokePassportDisclosure);
        this.on('provePassportValue', this.provePassportValue);
        return super.init();
    }

    // --- session + config ----------------------------------------------------

    private contractAddress(): string | null {
        return process.env.PASSPORT_CONTRACT_ADDRESS ?? null;
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
            const conn: any = await nightgate.send('connectWallet', { viewingKey });
            const sessionId = String(conn.sessionId);
            const signing: any = await nightgate.send('connectWalletForSigning', {
                sessionId, mnemonic
            });
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
                        state = 'error';
                        error = `${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim() || 'prewarm failed';
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
                const b: any = await nightgate.tx({ user: req.user }, (tx: any) =>
                    tx.send('getWalletBalance', { sessionId }));
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
                out.push(cold(secrets.id, label, 'error', String(e?.message ?? e ?? 'balance read failed')));
            }
        }
        return out;
    };

    private async passportRef(passportId: string) {
        return SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'payloadHash', 'passportIdHash', 'contractAddress')
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
        // Battery scalar fields (actual Batteries columns).
        const bat: any = await SELECT.one.from(Batteries)
            .columns(...(BATTERY_PROVABLE_FIELDS as readonly string[]))
            .where({ passport_ID: passportRowId });
        for (const f of BATTERY_PROVABLE_FIELDS) if (bat?.[f] != null) out[f] = bat[f];
        // Per-material recycled content (RecycledMaterials rows) → recycled<Material>Pct.
        const recs: any[] = await SELECT.from(RecycledMaterials)
            .columns('material', 'recycledPercentage')
            .where({ passport_ID: passportRowId });
        for (const r of recs || []) {
            if (r?.material && r.recycledPercentage != null) out[`recycled${r.material}Pct`] = r.recycledPercentage;
        }
        return out;
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
        const { canonicalPayload, payloadHash } = hashPayload({ batteries, recycledMaterials, diligenceDocs, attributes });
        const passportIdHash = blake2b256Hex(passportId);
        const payloadCipher = encryptPayload(canonicalPayload, passportId);

        const demoHost = process.env.PASSPORT_DEMO_HOST ?? 'https://passport.example';
        const contractAddress = this.contractAddress();
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
        const contractAddress = this.contractAddress() ?? row.contractAddress;
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
        const base = { value: v == null ? '' : String(v), scaledValue: '', found: v != null, fieldKey: fieldKeyHex(field), contentRoot: '', siblingsJson: '[]', dirsJson: '[]' };
        if (v == null) return base;

        // Build the content root + inclusion proof from the passport's provable
        // fields. Degrade gracefully (value still returned for display) if the
        // plugin's pure circuits aren't available.
        try {
            const tree = await buildContentRoot(values);
            const proof = tree.proofFor(field);
            base.contentRoot = tree.contentRoot;
            if (proof) {
                base.scaledValue = proof.value;
                base.siblingsJson = JSON.stringify(proof.siblings);
                base.dirsJson = JSON.stringify(proof.dirs);
            }
        } catch (e) {
            cds.log('producer').warn('content-root/proof build skipped:', (e as Error)?.message);
        }
        return base;
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
            .columns('sourceField', 'predicate', 'threshold', 'unit', 'txHash', 'createdAt')
            .where({ passport_ID: rowId.ID, status: 'succeeded', result: true })
            .orderBy('createdAt');
        const claims = proofs.map((c) => ({
            sourceField: c.sourceField, predicate: c.predicate,
            threshold: Number(c.threshold) / 1000, unit: c.unit ?? '',
            txHash: c.txHash ?? '', provenAt: c.createdAt ?? null,
        }));
        try {
            const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/passport/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
                body: JSON.stringify({ ...p, claims }),
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
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const pred = predicate === 'greaterOrEqual' ? 'greaterOrEqual' : 'lessOrEqual';
        const hash = norm(txHash);
        const contract = row.contractAddress || this.contractAddress();
        const proofLogId = cds.utils.uuid();
        const txRowId = cds.utils.uuid();

        if (result === false) {
            await INSERT.into(PredicateProofLog).entries({
                ID: proofLogId, passport_ID: row.ID, sourceField, predicate: pred, threshold: Number(threshold ?? 0),
                unit, txHash: hash || null, status: 'failed', result: false
            } as any);
            await INSERT.into(PassportTransactions).entries({
                ID: txRowId, passport_ID: row.ID, kind: 'provePredicate', txHash: hash || null,
                status: 'failed', explorerUrl: hash ? txExplorerUrl(hash) : null
            } as any);
            return { ok: true, txHash: hash, status: 'failed' };
        }

        await INSERT.into(PredicateProofLog).entries({
            ID: proofLogId, passport_ID: row.ID, sourceField, predicate: pred, threshold: Number(threshold ?? 0),
            unit, txHash: hash || null, status: 'pending', result: true
        } as any);
        await INSERT.into(PassportTransactions).entries({
            ID: txRowId, passport_ID: row.ID, kind: 'provePredicate', txHash: hash || null,
            status: 'pending', explorerUrl: hash ? txExplorerUrl(hash) : null
        } as any);

        const verdict = await this.settleWalletTx({
            txHash: hash, contractAddress: contract,
            // Crawler-free: confirm the vault recorded a true result
            // for this field-bound claim. The cockpit sends the already-scaled
            // threshold that the proof hashed, so it is passed straight through.
            stateCheck: () => verifyPredicateState({
                contractAddress: contract, payloadHash: row.payloadHash,
                fieldKey: fieldKeyHex(String(sourceField ?? '')), predicate: pred, threshold: Number(threshold ?? 0)
            }),
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
    };

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
        let contentRoot: string | undefined;
        try {
            const values = await this.fieldValuesFor(ID);
            if (Object.keys(values).length) contentRoot = (await buildContentRoot(values)).contentRoot;
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
                this.runAnchorDetached(ID, passportId, payloadHash, passportIdHash, contractAddress, sessionId, user, contentRoot, sponsorSessionId)
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
    private async runAnchorDetached(
        ID: string, passportId: string, payloadHash: string, passportIdHash: string,
        contractAddress: string, sessionId: string, user: unknown, contentRoot?: string,
        sponsorSessionId?: string
    ): Promise<void> {
        const log = cds.log('producer');
        try {
            const nightgate = await cds.connect.to('NightgateService');
            // First anchor after a fresh server signing session: the facade is
            // still being built/synced by the prewarm job; submitting earlier
            // fails with "No facade for sessionId". Await it once (detached
            // context, short read polls only).
            const prewarmJob = this.serverPrewarmJobs.get(sessionId);
            if (prewarmJob) {
                this.serverPrewarmJobs.delete(sessionId);
                log.info(`awaiting server-session prewarm ${prewarmJob} before first anchor...`);
                await waitForJobResult(nightgate, prewarmJob, sessionId, user);
                log.info('server-session prewarm complete');
            }
            if (sponsorSessionId) log.info(`anchor fees for ${passportId} sponsored by session ${sponsorSessionId.slice(0, 8)}...`);
            const { attestationTxHash } = await anchorPassport(nightgate, {
                payloadHash, passportId, passportIdHash, contractAddress, sessionId, user, contentRoot, sponsorSessionId,
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
        const contractAddress = this.contractAddress() ?? row.contractAddress;
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
        const field = sourceField || 'carbonFootprintKgCO2';
        const values = await this.fieldValuesFor(row.ID);
        const rawValue = values[field];
        if (rawValue == null) return req.reject(400, `value for '${field}' not found on this passport`);

        const thresholdScaled = Math.round(Number(threshold ?? 0) * 1000);
        const pred = predicate === 'greaterOrEqual' ? 'greaterOrEqual' : 'lessOrEqual';
        const useUnit = unit || 'milli-kg CO2 / kWh';
        const session = await this.effectiveSession(sessionId, walletId);
        const contractAddress = this.contractAddress() ?? row.contractAddress;

        if (!session || !contractAddress) {
            await INSERT.into(PredicateProofLog).entries({
                passport_ID: row.ID, sourceField: field, predicate: pred,
                threshold: thresholdScaled, unit: useUnit, status: 'offline'
            } as any);
            return { mode: 'offline', txHash: '', predicateAttestationId: '', result: null };
        }

        // Build the field-bound inclusion proof + content root. The proven value
        // is thus cryptographically tied to THIS passport's field, not a free
        // witness. Only PROVABLE_FIELDS are supported. (`values` already resolved.)
        const tree = await buildContentRoot(values);
        const proof = tree.proofFor(field);
        if (!proof) return req.reject(400, `field '${field}' is not a provable field`);

        // Detached like anchorRow: the ZK proof takes tens of seconds; holding
        // the request (and the UI) open for it is pointless and its request tx
        // would go snapshot-stale. Record a pending log row now, run the proof
        // after commit, and let the client poll the row.
        const proofLogId = cds.utils.uuid();
        await INSERT.into(PredicateProofLog).entries({
            ID: proofLogId, passport_ID: row.ID, sourceField: field, predicate: pred,
            threshold: thresholdScaled, unit: useUnit, status: 'pending'
        } as any);
        // The proof circuit binds against the root in the LEDGER; the worker
        // only (idempotently) re-anchors when `contentRoot` is supplied. Our
        // anchor sequence anchors the root at attest and passport content is
        // immutable after create, so re-sending it would just buy a redundant
        // anchorContentRoot tx (fee, ~20s, a confusing duplicate row). Supply
        // it only when no anchored root exists yet for this passport.
        const rootAnchored = await SELECT.one.from(PassportTransactions).columns('ID')
            .where({ passport_ID: row.ID, kind: 'anchorContentRoot', status: 'succeeded' });
        const sponsorSessionId = await this.sponsorSessionIdFor(String(session), sponsorWalletId);
        const args = {
            payloadHash: row.payloadHash, fieldKey: proof.fieldKey, value: proof.value,
            ...(rootAnchored ? {} : { contentRoot: tree.contentRoot }),
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
            const res: any = await sendDetached(nightgate, 'issueFieldPredicateAttestation', args, user);
            const jobResult: any = await waitForJobResult(
                nightgate, res.jobId, args.sessionId, user, { requireChainSuccess: true }
            );
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
