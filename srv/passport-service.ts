import cds from '@sap/cds';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { Passport, Passports } from '#cds-models/passport';

const { INSERT, SELECT } = cds.ql;

// --- Disclosure tiers (T20) --------------------------------------------------
//
// The Annex XIII disclosure boundary is enforced HERE, in the API layer, not on
// the chain (see db/passport-schema.cds). `after READ` handlers strip every
// field a tier may not see, so the same backend data renders three lawful views.
//
//   consumer  (anonymous)        → Annex XIII Point 1 only (public metadata).
//   recycler  (role 'recycler')  → + dismantling / cell chemistry / capacity /
//                                    recycled-content %  (legitimate interest).
//   authority (role 'authority') → everything: supplier identities, carbon
//                                    footprint, due-diligence docs, on-chain
//                                    lineage.
type Tier = 'consumer' | 'recycler' | 'authority';

const TIER_RANK: Record<Tier, number> = { consumer: 0, recycler: 1, authority: 2 };
function maxTier(a: Tier, b: Tier): Tier { return TIER_RANK[a] >= TIER_RANK[b] ? a : b; }
function levelToTier(level: number): Tier {
    return level >= 2 ? 'authority' : level === 1 ? 'recycler' : 'consumer';
}

/** Tier from the requester's configured CAP roles (the dev/mocked-auth path). */
function localTierOf(req: cds.Request): Tier {
    const user = req.user;
    if (user?.is('authority')) return 'authority';
    if (user?.is('recycler')) return 'recycler';
    return 'consumer';
}

// On-chain disclosure ACL (NIGHTGATE 0.3.4) ----------------------------------
//
// The AttestationVault `disclosures` Map is the tamper-evident, attester-
// controlled tier ACL; NIGHTGATE indexes it into `midnight.DisclosureGrants`
// (level 0/1/2) and binds principals to Bytes<32> grantee ids via
// `midnight.GranteeIdentities`. An active on-chain grant ELEVATES the tier
// above the requester's local role (never lowers it): additive, so the
// configured-role path keeps working when no grants exist. Grants are scoped
// per attestation (payloadHash), so elevation is resolved per passport row to
// avoid leaking one passport's grant onto another. All lookups degrade to
// 'consumer' on any failure, so a read can never break on the on-chain path.

/** The requester's on-chain grantee ids (memoized per request). */
async function granteesOf(req: cds.Request): Promise<string[]> {
    const memo = (req as any).__grantees as string[] | undefined;
    if (memo) return memo;
    let grantees: string[] = [];
    const userId = req.user?.id;
    if (userId && userId !== 'anonymous') {
        try {
            const rows = await cds.db.read('midnight.GranteeIdentities')
                .columns('granteeId').where({ userId });
            grantees = rows.map((r: Record<string, unknown>) => r.granteeId as string).filter(Boolean);
        } catch { /* plugin tables absent → no on-chain elevation */ }
    }
    (req as any).__grantees = grantees;
    return grantees;
}

/** On-chain tier granted to the requester for one passport (by payloadHash). */
async function onChainTierForPayload(req: cds.Request, payloadHash: unknown): Promise<Tier> {
    if (typeof payloadHash !== 'string' || !payloadHash) return 'consumer';
    const grantees = await granteesOf(req);
    if (!grantees.length) return 'consumer';
    try {
        const grants = await cds.db.read('midnight.DisclosureGrants')
            .columns('level').where({ payloadHash, grantee: { in: grantees }, active: true });
        let lvl = 0;
        for (const g of grants) lvl = Math.max(lvl, Number((g as Record<string, unknown>).level) || 0);
        return levelToTier(lvl);
    } catch { return 'consumer'; }
}

/** Fields on Passports beyond Annex XIII Point 1. Authority-only lineage. */
const PASSPORT_AUTHORITY_FIELDS = [
    'payloadHash', 'passportIdHash', 'contractAddress', 'attestationTxHash', 'attestation', 'attestation_ID'
] as const;

/** Delete a set of keys from a row in place. */
function strip(row: Record<string, unknown>, keys: readonly string[]): void {
    for (const k of keys) delete row[k];
}

/** Redact one Passports row (and any expanded children) for the given tier. */
function redactPassport(row: Record<string, unknown>, tier: Tier): void {
    if (tier !== 'authority') strip(row, PASSPORT_AUTHORITY_FIELDS);

    // Child compositions are restricted/legitimate-interest. A consumer sees
    // none of them; recycler/authority see them, redacted per-entity below.
    for (const child of ['batteries', 'recycledMaterials', 'diligenceDocs'] as const) {
        const val = row[child];
        if (!Array.isArray(val)) continue;
        if (tier === 'consumer') { row[child] = []; continue; }
    }
    if (Array.isArray(row.batteries)) row.batteries.forEach((b) => redactBattery(b, tier));
    if (Array.isArray(row.recycledMaterials)) row.recycledMaterials.forEach((m) => redactRecycled(m, tier));
    if (tier !== 'authority') row.diligenceDocs = [];
}

/** carbonFootprint + supplierName are authority-only; the rest is legitimate interest. */
function redactBattery(row: Record<string, unknown>, tier: Tier): void {
    if (tier !== 'authority') strip(row, ['carbonFootprintKgCO2', 'supplierName']);
}

/** sourceSupplierName (supplier identity) is authority-only. */
function redactRecycled(row: Record<string, unknown>, tier: Tier): void {
    if (tier !== 'authority') strip(row, ['sourceSupplierName']);
}

function asRows(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') return [data as Record<string, unknown>];
    return [];
}

/**
 * PassportService implementation (T19).
 *
 * `generatePassport(batchId, sessionId)` builds a battery passport from a
 * goods-receipt batch, commits its payload hash on Midnight via the NIGHTGATE
 * plugin, and returns the resolvable QR URL.
 *
 * Flow:
 *   1. Fetch batch data (T21 mock SAP, inlined seam until that lands).
 *   2. payload_hash = blake2b-256(canonical JSON of the private payload).
 *   3. Encrypt the payload with a per-passport key → Passports.payloadCipher.
 *   4. Anchor diligence docs + the passport payload on-chain via the plugin.
 *   5. Poll getJobStatus until the attestation tx is included.
 *   6. INSERT the Passports row with the resulting txHash + payloadHash.
 *   7. QR URL = https://<demoHost>/p/<passportId>.
 *
 * On-chain step uses `anchorDocument` (which hex-decodes + calls the
 * AttestationVault `attest` circuit internally). The passportId→payload_hash
 * `bindPassport` call is DEFERRED. `submitContractCall` cannot pass Bytes<32>
 * args yet (NIGHTGATE FR: docs/feature-requests/submitcontractcall-bytes-args.md).
 * Until then the mapping lives in the Passports row (passportId + payloadHash),
 * which T23's resolver reads off-chain.
 *
 * If `sessionId` is omitted the deterministic off-chain steps still run and the
 * tx fields stay null. An offline/dev path that needs no wallet.
 */
export default class PassportService extends cds.ApplicationService {
    override async init(): Promise<void> {
        this.on('generatePassport', this.generatePassport);

        // Disclosure-tier gating (T20): redact restricted fields per requester
        // tier on every read (the Annex XIII boundary). Base tier is the
        // requester's CAP role; an active on-chain DisclosureGrant (NIGHTGATE
        // 0.3.4) can elevate it per passport. Handlers target the SERVICE
        // projections (unqualified names, relative to PassportService), not the
        // db-level `passport.*` entities the cds-typer classes resolve to, which
        // a service READ never matches.
        this.after('READ', 'Passports', async (data, req) => {
            const local = localTierOf(req);
            for (const row of asRows(data)) {
                const tier = maxTier(local, await onChainTierForPayload(req, row.payloadHash));
                redactPassport(row, tier);
            }
        });
        // Direct child reads carry no passport scope, so on-chain (per-attestation)
        // grants can't be resolved here; gate on the local role only.
        this.after('READ', 'Batteries', (data, req) => {
            const tier = localTierOf(req);
            asRows(data).forEach((row) => redactBattery(row, tier));
        });
        this.after('READ', 'RecycledMaterials', (data, req) => {
            const tier = localTierOf(req);
            asRows(data).forEach((row) => redactRecycled(row, tier));
        });
        // DiligenceDoc is authority-only in full; below-tier requests get nothing.
        this.after('READ', 'DiligenceDoc', (data, req) => {
            if (localTierOf(req) === 'authority') return;
            asRows(data).forEach((row) => strip(row, Object.keys(row)));
        });

        return super.init();
    }

    private generatePassport = async (req: cds.Request) => {
        const { batchId, sessionId } = req.data as { batchId?: string; sessionId?: string };
        if (!batchId) return req.reject(400, 'batchId is required');

        // 1. Fetch batch data. T21 (mock SAP) will replace this; the seam keeps
        //    the contract stable. For now resolve a demo batch by id.
        const batch = resolveBatch(batchId);
        if (!batch) return req.reject(404, `batch '${batchId}' not found`);
        const passportId = batch.passportId;

        // passportId is unique (Regulation 2023/1542). Reject re-generation of an
        // existing passport rather than creating a duplicate row.
        const existing = await SELECT.one.from(Passports).columns('ID').where({ passportId });
        if (existing) return req.reject(409, `passport '${passportId}' already exists`);

        // 2. Canonical payload + blake2b-256 hash. The hash is what goes on-chain;
        //    the payload body stays off-chain (encrypted, step 3). The passportId
        //    is a human string, so derive a stable Bytes<32> id for the on-chain
        //    binding by hashing it the same way.
        const canonicalPayload = canonicalize(batch.payload);
        const payloadHash = bytesToHex(blake2b(Buffer.from(canonicalPayload, 'utf8'), { dkLen: 32 }));
        const passportIdHash = bytesToHex(blake2b(Buffer.from(passportId, 'utf8'), { dkLen: 32 }));

        // 3. Encrypt the payload with a per-passport key derived from passportId.
        const payloadCipher = encryptPayload(canonicalPayload, passportId);

        const demoHost = process.env.PASSPORT_DEMO_HOST ?? 'https://passport.example';
        const qrCodeUrl = `${demoHost}/p/${passportId}`;
        const contractAddress = process.env.PASSPORT_CONTRACT_ADDRESS ?? null;

        // 4 + 5. On-chain anchor (only when a signing session is supplied).
        let attestationTxHash: string | null = null;
        if (sessionId) {
            const nightgate = await cds.connect.to('nightgate');
            // anchorDocument hex-decodes sha256 and calls AttestationVault.attest
            // on our registered contract. contractAddress must be a deployment of
            // 'passport-attestation' the session can sign for.
            if (!contractAddress) {
                return req.reject(400,
                    'PASSPORT_CONTRACT_ADDRESS env is required for on-chain anchoring (a deployed passport-attestation address)');
            }
            const anchor: any = await nightgate.send('anchorDocument', {
                sha256:              payloadHash,
                storageRef:          `passport://${passportId}`,
                sessionId,
                contractAddress,
                contentType:         'application/json',
                compiledArtifactRef: 'passport-attestation'
            });
            attestationTxHash = await waitForJob(nightgate, anchor.jobId, sessionId);

            // Anchor the passportId → payload_hash binding on-chain via the
            // passport-attestation `bindPassport` circuit. Args are Bytes<32>,
            // passed as hex strings and coerced server-side (NIGHTGATE 0.3.2
            // arg-coercion, FR submitcontractcall-bytes-args.md, RESOLVED).
            const bind: any = await nightgate.send('submitContractCall', {
                contractAddress,
                circuit:             'bindPassport',
                compiledArtifactRef: 'passport-attestation',
                sessionId,
                args:                JSON.stringify([passportIdHash, payloadHash])
            });
            await waitForJob(nightgate, bind.jobId, sessionId);
        }

        // 6. Persist the passport row (payloadCipher excluded from the read
        //    projection; stored here on the base entity). Cast on entries: the
        //    LargeBinary column is typed `Readable | null` by cds-types, but the
        //    runtime accepts a Buffer for binary inserts.
        await INSERT.into(Passports).entries({
            passportId,
            manufacturerId:   batch.public.manufacturerId,
            batteryCategory:  batch.public.batteryCategory as Passport['batteryCategory'],
            model:            batch.public.model,
            manufactureDate:  batch.public.manufactureDate as Passport['manufactureDate'],
            weightKg:         batch.public.weightKg,
            performanceClass: batch.public.performanceClass,
            qrCodeUrl,
            payloadCipher:    payloadCipher as unknown as Passport['payloadCipher'],
            payloadHash,
            passportIdHash,
            contractAddress,
            attestationTxHash
        });

        // 7. Return the action result, incl. the QR as a data-URL PNG (T23).
        const qrCodePng = await QRCode.toDataURL(qrCodeUrl, { width: 320, margin: 1 });
        return { passportId, attestationTxHash, qrCodeUrl, qrCodePng };
    };
}

// --- Batch source (T21 seam) -------------------------------------------------

interface Batch {
    passportId: string;
    public: {
        manufacturerId: string;
        batteryCategory: string;
        model: string;
        manufactureDate: string;
        weightKg: number;
        performanceClass: string;
    };
    /** Shielded payload (Annex XIII Points 2-4). Hashed and encrypted, never public. */
    payload: Record<string, unknown>;
}

/**
 * Resolve a goods-receipt batch by id. Placeholder for T21 (mock SAP service);
 * returns a demo batch matching the T17 seed so the flow is exercisable now.
 */
function resolveBatch(batchId: string): Batch | null {
    if (batchId !== 'BATCH-PREVIEW-0001') return null;
    return {
        passportId: 'BAT-PREVIEW-0001',
        public: {
            manufacturerId:   'DE-CELLCO-001',
            batteryCategory:  'EV',
            model:            'PowerCell EV-75',
            manufactureDate:  '2026-03-15',
            weightKg:         432.5,
            performanceClass: 'B'
        },
        payload: {
            batteries: [{
                serialNumber: 'SN-AX-0001',
                cellChemistry: 'NMC-811',
                capacityKwh: 75.0,
                carbonFootprintKgCO2: 3412.75,
                supplierName: 'CathodeWorks GmbH'
            }],
            recycledMaterials: [
                { material: 'Co', recycledPercentage: 16.5, sourceSupplierName: 'ReCobalt Recyclers SA' },
                { material: 'Li', recycledPercentage: 8.25, sourceSupplierName: 'LiLoop Recycling BV' },
                { material: 'Ni', recycledPercentage: 12.0, sourceSupplierName: 'NickelBack Materials Oy' }
            ],
            diligenceDocs: [{ docType: 'supply-chain-due-diligence-report' }]
        }
    };
}

// --- Helpers -----------------------------------------------------------------

/**
 * Deterministic canonical JSON: object keys sorted recursively so the same
 * logical payload always hashes to the same payload_hash.
 */
function canonicalize(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>).sort()
                .map(k => [k, sortKeys((value as Record<string, unknown>)[k])])
        );
    }
    return value;
}

/**
 * AES-256-GCM encrypt with a per-passport key derived via HKDF from the app
 * secret (ENCRYPTION_KEY) and passportId as salt. Output layout: iv(12) ||
 * authTag(16) || ciphertext, returned as a Buffer for the LargeBinary column.
 */
function encryptPayload(plaintext: string, passportId: string): Buffer {
    const masterHex = process.env.ENCRYPTION_KEY;
    const master = masterHex
        ? Buffer.from(masterHex, 'hex')
        : Buffer.from('00'.repeat(32), 'hex'); // dev fallback; prod must set ENCRYPTION_KEY
    const key = Buffer.from(
        hkdfSync('sha256', master, Buffer.from(passportId, 'utf8'), Buffer.from('passport-payload'), 32)
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
}

/**
 * Poll a NIGHTGATE async job to completion and return its tx hash.
 * Throws on job failure. ~2.5 min cap (30 × 5s); proof and submit are slow.
 */
async function waitForJob(nightgate: cds.Service, jobId: string, sessionId: string): Promise<string> {
    for (let i = 0; i < 30; i++) {
        const job: any = await nightgate.send('getJobStatus', { jobId, sessionId });
        if (job.status === 'succeeded') {
            const result = job.result ? JSON.parse(job.result) : {};
            return String(result.txHash ?? '');
        }
        if (job.status === 'failed') {
            throw new Error(`anchor job failed: ${job.errorCode ?? ''} ${job.errorMessage ?? ''}`.trim());
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`anchor job ${jobId} did not complete within timeout`);
}
