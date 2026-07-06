import cds from '@sap/cds';
import {
    Passports, Batteries, RecycledMaterials, DiligenceDoc,
    PassportTransactions, DisclosureGrantLog, PredicateProofLog
} from '#cds-models/passport';
import {
    hashPayload, blake2b256Hex, encryptPayload, anchorPassport, waitForJob,
    buildContentRoot, fieldKeyHex, BATTERY_PROVABLE_FIELDS
} from './lib/passport-anchor';
import { verifyContractTx, type ChainVerdict } from './lib/chain-verify';

const CONTRACT_REF = 'attestation-vault';

const { INSERT, SELECT, UPDATE } = cds.ql;

const EXPLORER = 'https://preview.midnightexplorer.com';
const norm = (h?: string | null): string => String(h ?? '').replace(/^0x/, '');
function txExplorerUrl(hash?: string | null): string | null {
    return hash ? `${EXPLORER}/transactions/0x${String(hash).replace(/^0x/, '')}` : null;
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
 * ProducerService — manufacturer / ERP cockpit write side. See producer-service.cds.
 *
 * Every action is offline-first: it always persists the local row / log, and only
 * touches the chain when a signing session + contract are available (`mode`
 * 'onchain' vs 'offline'). The proven anchor sequence is shared with
 * PassportService via srv/lib/passport-anchor.
 */
export default class ProducerService extends cds.ApplicationService {
    private serverSessionId: string | null = null;

    override async init(): Promise<void> {
        this.on('createPassport', this.createPassport);
        this.on('submitPassport', this.submitPassport);
        this.on('recordWalletAttest', this.recordWalletAttest);
        this.on('recordWalletDisclosure', this.recordWalletDisclosure);
        this.on('recordWalletPredicate', this.recordWalletPredicate);
        this.on('passportFieldValue', this.passportFieldValue);
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

    /** Lazy server signing session from env (PRODUCER_VIEWING_KEY + mnemonic/seed). */
    private async serverSigningSession(): Promise<string | null> {
        if (this.serverSessionId) return this.serverSessionId;
        const viewingKey = process.env.PRODUCER_VIEWING_KEY;
        const mnemonic = process.env.PRODUCER_WALLET_MNEMONIC;
        const seedHex = process.env.PRODUCER_WALLET_SEED_HEX;
        if (!viewingKey || !(mnemonic || seedHex)) return null;
        try {
            const nightgate = await cds.connect.to('nightgate');
            const conn: any = await nightgate.send('connectWallet', { viewingKey });
            const sessionId = String(conn.sessionId);
            await nightgate.send('connectWalletForSigning', {
                sessionId, ...(mnemonic ? { mnemonic } : { seedHex })
            });
            this.serverSessionId = sessionId;
            return sessionId;
        } catch (e) {
            cds.log('producer').warn('server signing session unavailable:', (e as Error)?.message);
            return null;
        }
    }

    /** Explicit arg session wins; otherwise fall back to the server session. */
    private async effectiveSession(argSessionId?: string): Promise<string | null> {
        return argSessionId || this.serverSigningSession();
    }

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
        const { passportJson, submit, sessionId, owner } = req.data as
            { passportJson?: string; submit?: boolean; sessionId?: string; owner?: string };

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
        const { canonicalPayload, payloadHash } = hashPayload({ batteries, recycledMaterials, diligenceDocs });
        const passportIdHash = blake2b256Hex(passportId);
        const payloadCipher = encryptPayload(canonicalPayload, passportId);

        const demoHost = process.env.PASSPORT_DEMO_HOST ?? 'https://passport.example';
        const contractAddress = this.contractAddress();
        const ID = cds.utils.uuid();

        await INSERT.into(Passports).entries({
            ID,
            passportId,
            owner:            owner || null,
            manufacturerId:   input.manufacturerId,
            batteryCategory:  input.batteryCategory as any,
            model:            input.model,
            manufactureDate:  input.manufactureDate as any,
            weightKg:         input.weightKg,
            performanceClass: input.performanceClass,
            qrCodeUrl:        `${demoHost}/p/${passportId}`,
            payloadCipher:    payloadCipher as any,
            payloadHash,
            passportIdHash,
            contractAddress,
            status:           'draft',
            batteries:         batteries.map((b) => ({ ...b })),
            recycledMaterials: recycledMaterials.map((m) => ({ ...m })),
            diligenceDocs:     diligenceDocs.map((d) => ({ docType: d.docType }))
        } as any);

        const session = submit ? await this.effectiveSession(sessionId) : null;
        if (submit && session && contractAddress) {
            return this.anchorRow(req, ID, passportId, payloadHash, passportIdHash, contractAddress, session, true);
        }
        // Offline: record a placeholder tx row so the overview shows the draft.
        await INSERT.into(PassportTransactions).entries({ passport_ID: ID, kind: 'attest', status: 'offline' } as any);
        return { passportId, payloadHash, mode: 'offline', txHash: '' };
    };

    private submitPassport = async (req: cds.Request) => {
        const { passportId, sessionId } = req.data as { passportId?: string; sessionId?: string };
        const row: any = await this.passportRef(String(passportId ?? ''));
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const contractAddress = this.contractAddress() ?? row.contractAddress;
        const session = await this.effectiveSession(sessionId);
        if (!session || !contractAddress) {
            return req.reject(400, 'no signing session / PASSPORT_CONTRACT_ADDRESS available — cannot submit on-chain');
        }
        const r = await this.anchorRow(req, row.ID, row.passportId, row.payloadHash, row.passportIdHash, contractAddress, session, false);
        return { passportId: r.passportId, mode: r.mode, txHash: r.txHash };
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
     * (to anchor), and the Merkle path (siblings/dirs as JSON) — everything the
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
        // plugin's pure circuits aren't available (e.g. pre-0.4.3).
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
                'contractAddress', 'attestationTxHash', 'status', 'payloadHash')
            .where({ passportId });
        if (!p) return req.reject(404, `passport '${passportId}' not found`);
        const proofs: any[] = await SELECT.from(PredicateProofLog)
            .columns('sourceField', 'predicate', 'threshold', 'unit', 'txHash', 'result')
            .where({ passport_ID: p.ID, status: 'succeeded' });
        const explorer = (h: unknown) => (h ? `https://preview.midnightexplorer.com/transactions/0x${String(h).replace(/^0x/, '')}` : null);
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
     * Structurally verify a wallet-submitted tx, then finalize the row.
     *
     * Runs one inline check. On `confirmed` it finalizes now; on `failed` it marks
     * the row failed; on `unknown` (indexer disabled or lagging) it leaves the row
     * PENDING and retries detached for a bounded window before giving up. A row is
     * never promoted to succeeded on the client's word alone.
     */
    private async settleWalletTx(o: {
        txHash: string;
        contractAddress?: string | null;
        onConfirmed: () => Promise<void>;
        onFailed: () => Promise<void>;
    }): Promise<ChainVerdict> {
        const check = (): Promise<ChainVerdict> => verifyContractTx(o.txHash, { contractAddress: o.contractAddress });
        let verdict: ChainVerdict = 'unknown';
        try { verdict = await check(); } catch { verdict = 'unknown'; }
        if (verdict === 'confirmed') { await o.onConfirmed(); return verdict; }
        if (verdict === 'failed') { await o.onFailed(); return verdict; }
        // unknown: the indexer may just be lagging. Retry off the request path.
        if (o.txHash) this.trackWalletTx(check, o.onConfirmed, o.onFailed);
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

    /** Shared anchor+persist: attest + bindPassport, log each tx, update status. */
    private async anchorRow(
        req: cds.Request, ID: string, passportId: string, payloadHash: string,
        passportIdHash: string, contractAddress: string, sessionId: string, includePayloadHash: boolean
    ) {
        await UPDATE.entity(Passports).set({ status: 'anchoring' }).where({ ID });
        const nightgate = await cds.connect.to('nightgate');
        // Build the content root over the passport's provable fields so the
        // anchor sequence also pins it on-chain (enables field-bound proofs).
        let contentRoot: string | undefined;
        try {
            const values = await this.fieldValuesFor(ID);
            if (Object.keys(values).length) contentRoot = (await buildContentRoot(values)).contentRoot;
        } catch (e) {
            cds.log('producer').warn('content-root build skipped:', (e as Error)?.message);
        }
        try {
            const { attestationTxHash } = await anchorPassport(nightgate, {
                payloadHash, passportId, passportIdHash, contractAddress, sessionId, contentRoot,
                onStep: async (s) => {
                    await INSERT.into(PassportTransactions).entries({
                        passport_ID: ID, kind: s.kind, jobId: s.jobId, txHash: s.txHash,
                        status: 'succeeded', explorerUrl: txExplorerUrl(s.txHash)
                    } as any);
                }
            });
            await UPDATE.entity(Passports).set({ status: 'anchored', attestationTxHash, contractAddress }).where({ ID });
            return { passportId, payloadHash: includePayloadHash ? payloadHash : undefined, mode: 'onchain', txHash: attestationTxHash };
        } catch (e) {
            await UPDATE.entity(Passports).set({ status: 'failed' }).where({ ID });
            await INSERT.into(PassportTransactions).entries({
                passport_ID: ID, kind: 'attest', status: 'failed', errorMessage: String((e as Error)?.message ?? e)
            } as any);
            return req.reject(502, `on-chain anchor failed: ${(e as Error)?.message ?? e}`);
        }
    }

    // --- disclosure ----------------------------------------------------------

    private grantPassportDisclosure = async (req: cds.Request) => {
        const { passportId, grantee, level, sessionId } = req.data as
            { passportId?: string; grantee?: string; level?: number; sessionId?: string };
        return this.disclosure(req, 'grant', String(passportId ?? ''), String(grantee ?? ''), Number(level ?? 0), sessionId);
    };

    private revokePassportDisclosure = async (req: cds.Request) => {
        const { passportId, grantee, sessionId } = req.data as
            { passportId?: string; grantee?: string; sessionId?: string };
        return this.disclosure(req, 'revoke', String(passportId ?? ''), String(grantee ?? ''), 0, sessionId);
    };

    private async disclosure(req: cds.Request, op: 'grant' | 'revoke', passportId: string, grantee: string, level: number, argSession?: string) {
        if (!grantee) return req.reject(400, 'grantee is required');
        const row: any = await this.passportRef(passportId);
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const contractAddress = this.contractAddress() ?? row.contractAddress;
        const session = await this.effectiveSession(argSession);

        if (!session || !contractAddress) {
            await INSERT.into(DisclosureGrantLog).entries({ passport_ID: row.ID, grantee, level, op, status: 'offline' } as any);
            return { mode: 'offline', txHash: '' };
        }
        const nightgate = await cds.connect.to('nightgate');
        const action = op === 'grant' ? 'grantDisclosure' : 'revokeDisclosure';
        const args: Record<string, unknown> = {
            payloadHash: row.payloadHash, grantee, sessionId: session,
            contractAddress, compiledArtifactRef: CONTRACT_REF
        };
        if (op === 'grant') args.level = level;
        const res: any = await nightgate.send(action, args);
        const txHash = await waitForJob(nightgate, res.jobId, session);
        await INSERT.into(DisclosureGrantLog).entries({ passport_ID: row.ID, grantee, level, op, txHash, status: 'succeeded' } as any);
        await INSERT.into(PassportTransactions).entries({
            passport_ID: row.ID, kind: op === 'grant' ? 'grantDisclosure' : 'revokeDisclosure',
            jobId: res.jobId, txHash, status: 'succeeded', explorerUrl: txExplorerUrl(txHash)
        } as any);
        return { mode: 'onchain', txHash };
    }

    // --- predicate proof -----------------------------------------------------

    private provePassportValue = async (req: cds.Request) => {
        const { passportId, sourceField, predicate, threshold, unit, sessionId } = req.data as {
            passportId?: string; sourceField?: string; predicate?: string;
            threshold?: number; unit?: string; sessionId?: string;
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
        const session = await this.effectiveSession(sessionId);
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

        const nightgate = await cds.connect.to('nightgate');
        try {
            const res: any = await nightgate.send('issueFieldPredicateAttestation', {
                payloadHash: row.payloadHash, fieldKey: proof.fieldKey, value: proof.value,
                contentRoot: tree.contentRoot,
                siblingsJson: JSON.stringify(proof.siblings), dirsJson: JSON.stringify(proof.dirs),
                predicate: pred, threshold: thresholdScaled, unit: useUnit,
                sessionId: session, contractAddress, compiledArtifactRef: CONTRACT_REF
            });
            const txHash = await waitForJob(nightgate, res.jobId, session);
            await INSERT.into(PredicateProofLog).entries({
                passport_ID: row.ID, sourceField: field, predicate: pred, threshold: thresholdScaled,
                unit: useUnit, predicateAttestationId: res.predicateAttestationId, txHash, status: 'succeeded', result: true
            } as any);
            await INSERT.into(PassportTransactions).entries({
                passport_ID: row.ID, kind: 'provePredicate', jobId: res.jobId, txHash,
                status: 'succeeded', explorerUrl: txExplorerUrl(txHash)
            } as any);
            return { mode: 'onchain', txHash, predicateAttestationId: String(res.predicateAttestationId ?? ''), result: true };
        } catch (e) {
            // A rejected predicate (value fails the bound) surfaces as a failed tx.
            await INSERT.into(PredicateProofLog).entries({
                passport_ID: row.ID, sourceField: field, predicate: pred, threshold: thresholdScaled,
                unit: useUnit, status: 'failed', result: false
            } as any);
            return { mode: 'onchain', txHash: '', predicateAttestationId: '', result: false, error: String((e as Error)?.message ?? e) };
        }
    };
}
