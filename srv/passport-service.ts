import cds from '@sap/cds';
import QRCode from 'qrcode';
import { Passport, Passports, PredicateProofLog, Partners } from '#cds-models/passport';
import { hashPayload, blake2b256Hex, encryptPayload, anchorPassport, effectiveNetwork, explorerTxUrl, verifyPeers } from './lib/passport-anchor';
import { defaultGuideAttributes, hashableAttributes } from './lib/guide-attribute-defaults';
import { granteeIdForDid } from './lib/grantee';
import { rowToBatch, type Batch, type GoodsReceiptRow } from './lib/goods-receipt';

const { INSERT, SELECT, UPDATE } = cds.ql;

// --- Disclosure tiers --------------------------------------------------
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

// On-chain disclosure ACL ----------------------------------
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

/**
 * Effective disclosure grants for a set of grantee ids → Map(payloadHash → maxLevel).
 * Unions two sources so the demo works offline and stays on-chain-ready:
 *   (a) on-chain indexed grants (`midnight.DisclosureGrants`, active), the real ACL.
 *   (b) producer-side offline log (`passport.DisclosureGrantLog`): latest op per
 *       (payloadHash, grantee); counts only if the newest op is `grant`.
 */
async function effectiveGrantsFor(grantees: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!grantees.length) return out;
    const bump = (ph: unknown, lvl: unknown) => {
        if (typeof ph !== 'string' || !ph) return;
        const n = Number(lvl) || 0;
        out.set(ph, Math.max(out.get(ph) ?? -1, n));
    };
    // (a) on-chain
    try {
        const rows = await cds.db.read('midnight.DisclosureGrants')
            .columns('payloadHash', 'level').where({ grantee: { in: grantees }, active: true });
        for (const g of rows as Record<string, unknown>[]) bump(g.payloadHash, g.level);
    } catch { /* plugin tables absent */ }
    // (b) offline producer log: latest op per (passport, grantee); if it's a
    // `grant`, map passport_ID → payloadHash and count it. Only settled rows count
    // (`succeeded` = chain-verified, `offline` = no-chain demo grant); a `pending`
    // wallet grant must NOT elevate a tier before its tx is verified on-chain.
    try {
        const rows = await SELECT.from('passport.DisclosureGrantLog')
            .columns('grantee', 'level', 'op', 'createdAt', 'passport_ID')
            .where({ grantee: { in: grantees }, status: { in: ['succeeded', 'offline'] } })
            .orderBy('createdAt asc');
        const latest = new Map<string, Record<string, unknown>>();
        for (const r of rows as Record<string, unknown>[]) latest.set(`${r.passport_ID}|${r.grantee}`, r);
        const granted = [...latest.values()].filter((r) => r.op === 'grant');
        if (granted.length) {
            const ids = [...new Set(granted.map((r) => r.passport_ID))];
            const ps = await SELECT.from(Passports).columns('ID', 'payloadHash').where({ ID: { in: ids } });
            const idToHash = new Map((ps as Record<string, unknown>[]).map((p) => [p.ID, p.payloadHash]));
            for (const r of granted) bump(idToHash.get(r.passport_ID), r.level);
        }
    } catch { /* no offline grants */ }
    return out;
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
    // Guide-format attributes carry their own longlist access class per row.
    // Fail closed: a row whose accessClass was not selected ($expand with a
    // narrow $select) cannot be classified and is only served to authority.
    if (Array.isArray(row.attributes)) {
        row.attributes = row.attributes.filter((a) => {
            const cls = (a as Record<string, unknown>)?.accessClass;
            return typeof cls === 'string' ? attributeVisible(cls, tier) : tier === 'authority';
        });
    }
}

/**
 * carbonFootprint + supplierName are authority-only; the rest is legitimate
 * interest, so a consumer sees nothing at all. That matters on DIRECT child
 * reads (GET /Batteries): via a Passports $expand the consumer's children are
 * already emptied, but the direct read must not leak Points 2/3 fields to
 * anonymous callers on a public host.
 */
function redactBattery(row: Record<string, unknown>, tier: Tier): void {
    if (tier === 'consumer') { strip(row, Object.keys(row)); return; }
    if (tier !== 'authority') strip(row, ['carbonFootprintKgCO2', 'supplierName']);
}

/** sourceSupplierName (supplier identity) is authority-only; consumers see nothing. */
function redactRecycled(row: Record<string, unknown>, tier: Tier): void {
    if (tier === 'consumer') { strip(row, Object.keys(row)); return; }
    if (tier !== 'authority') strip(row, ['sourceSupplierName']);
}

/** Which longlist access classes a tier may read (guide-format attribute rows). */
function attributeVisible(accessClass: unknown, tier: Tier): boolean {
    if (accessClass === 'authority') return tier === 'authority';
    if (accessClass === 'legitimateInterest') return tier !== 'consumer';
    return true; // public (also rows with no class yet)
}

function asRows(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') return [data as Record<string, unknown>];
    return [];
}

/**
 * PassportService implementation
 *
 * `generatePassport(batchId, sessionId)` builds a battery passport from a
 * goods-receipt batch, commits its payload hash on Midnight via the NIGHTGATE
 * plugin, and returns the resolvable QR URL.
 *
 * Flow:
 *   1. Fetch batch data
 *   2. payload_hash = blake2b-256(canonical JSON of the private payload).
 *   3. Encrypt the payload with a per-passport key → Passports.payloadCipher.
 *   4. Anchor on-chain via the shared sequence in srv/lib/passport-anchor
 *      (attest + bindPassport + content root), polling each job to inclusion.
 *   5. INSERT the Passports row with the resulting txHash + payloadHash.
 *   6. QR URL = https://<demoHost>/p/<passportId>.
 *
 * If `sessionId` is omitted the deterministic off-chain steps still run and the
 * tx fields stay null. An offline/dev path that needs no wallet.
 */
export default class PassportService extends cds.ApplicationService {
    override async init(): Promise<void> {
        this.on('generatePassport', this.generatePassport);
        this.on('resolveByHash', this.resolveByHash);
        this.on('passportCredential', this.passportCredential);
        this.on('registerPartner', this.registerPartner);
        this.on('verifyOnChain', this.verifyOnChain);
        this.on('anchorExplorer', this.anchorExplorer);

        // Disclosure-tier gating: redact restricted fields per requester
        // tier on every read (the Annex XIII boundary). Base tier is the
        // requester's CAP role; an active on-chain DisclosureGrant can
        // elevate it per passport. Handlers target the SERVICE
        // projections (unqualified names, relative to PassportService), not the
        // db-level `passport.*` entities the cds-typer classes resolve to, which
        // a service READ never matches.
        // The disclosure gate matches grants by payloadHash, so it must be in the
        // row even when the client didn't $select it. Inject it up front; it is
        // then stripped again by redactPassport for non-authority tiers.
        this.before('READ', 'Passports', (req) => {
            const cols = (req.query as any)?.SELECT?.columns as any[] | undefined;
            if (Array.isArray(cols) && !cols.some((c) => c === '*' || (c?.ref && c.ref[0] === 'payloadHash'))) {
                cols.push({ ref: ['payloadHash'] });
            }
        });

        this.after('READ', 'Passports', async (data, req) => {
            const local = localTierOf(req);
            const grantees = await granteesOf(req);
            // A registered dataspace partner (DID login, role 'partner') has no
            // local tier; the GRANT LEVEL per passport drives disclosure, and
            // they see ONLY passports granted to them. Built-in demo users and
            // the producer keep role-based behavior (no list scoping).
            const isPartner = !!req.user?.is?.('partner');
            const effective = grantees.length ? await effectiveGrantsFor(grantees) : null;
            const kept: Record<string, unknown>[] = [];
            for (const row of asRows(data)) {
                const ph = typeof row.payloadHash === 'string' ? row.payloadHash : '';
                const grantLvl = effective && ph ? (effective.get(ph) ?? -1) : -1;
                if (isPartner && grantLvl < 0) continue; // partner: granted passports only
                const grantTier: Tier = grantLvl >= 0 ? levelToTier(grantLvl) : 'consumer';
                redactPassport(row, maxTier(local, grantTier));
                kept.push(row);
            }
            if (isPartner && Array.isArray(data)) data.splice(0, data.length, ...kept);
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
        // Direct and nav-property reads on the guide-attribute rows: restrict
        // BEFORE the database via a tier where-clause. Row-level after-READ
        // filtering is not enough here: clients control $select, and a row
        // fetched without its accessClass column cannot be classified anymore.
        this.before('READ', 'PassportAttributes', (req) => {
            const tier = localTierOf(req);
            if (tier === 'authority') return;
            const allowed = tier === 'recycler' ? ['public', 'legitimateInterest'] : ['public'];
            (req.query as any).where({ accessClass: { in: allowed } });
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

        // 1. Fetch batch data from the mock SAP goods-receipt feed. The row
        //    carries the public header + the shielded payload; rowToBatch parses it.
        const batch = await resolveBatch(batchId);
        if (!batch) return req.reject(404, `batch '${batchId}' not found`);
        const passportId = batch.passportId;

        // passportId is unique (Regulation 2023/1542). Reject re-generation of an
        // existing passport rather than creating a duplicate row.
        const existing = await SELECT.one.from(Passports).columns('ID').where({ passportId });
        if (existing) return req.reject(409, `passport '${passportId}' already exists`);

        // 2. Canonical payload + blake2b-256 hash. The hash is what goes on-chain;
        //    the payload body stays off-chain (encrypted, step 3). The passportId
        //    is a human string, so derive a stable Bytes<32> id for the on-chain
        //    binding by hashing it the same way. Guide-format attributes (DIN DKE
        //    SPEC 99100 longlist) are part of the anchored payload, canonically
        //    sorted so row order never changes the hash.
        const attributes = hashableAttributes(defaultGuideAttributes({
            passportId, model: batch.public.model, performanceClass: batch.public.performanceClass,
            batteryCategory: batch.public.batteryCategory,
        }));
        const { canonicalPayload, payloadHash } = hashPayload({ ...batch.payload, attributes });
        const passportIdHash = blake2b256Hex(passportId);

        // 3. Encrypt the payload with a per-passport key derived from passportId.
        const payloadCipher = encryptPayload(canonicalPayload, passportId);

        const demoHost = process.env.PASSPORT_DEMO_HOST ?? 'https://passport.example';
        const qrCodeUrl = `${demoHost}/p/${passportId}`;
        const contractAddress = process.env.PASSPORT_CONTRACT_ADDRESS ?? null;

        // 4. On-chain anchor (only when a signing session is supplied); the
        // sequence is shared with the producer cockpit via srv/lib/passport-anchor.
        let attestationTxHash: string | null = null;
        if (sessionId) {
            if (!contractAddress) {
                return req.reject(400,
                    'PASSPORT_CONTRACT_ADDRESS env is required for on-chain anchoring (a deployed attestation-vault address)');
            }
            const nightgate = await cds.connect.to('NightgateService');
            ({ attestationTxHash } = await anchorPassport(nightgate, {
                payloadHash, passportId, passportIdHash, contractAddress, sessionId, user: req.user
            }));
        }

        // 5. Persist the passport row (payloadCipher excluded from the read
        //    projection; stored here on the base entity). Cast on entries: the
        //    LargeBinary column is typed `Readable | null` by cds-types, but the
        //    runtime accepts a Buffer for binary inserts.
        await INSERT.into(Passports).entries({
            passportId,
            manufacturerId: batch.public.manufacturerId,
            batteryCategory: batch.public.batteryCategory as Passport['batteryCategory'],
            model: batch.public.model,
            manufactureDate: batch.public.manufactureDate as Passport['manufactureDate'],
            weightKg: batch.public.weightKg,
            performanceClass: batch.public.performanceClass,
            qrCodeUrl,
            payloadCipher: payloadCipher as unknown as Passport['payloadCipher'],
            payloadHash,
            passportIdHash,
            contractAddress,
            anchorNetwork: contractAddress ? effectiveNetwork() : null,
            attestationTxHash,
            attributes: attributes.map((a) => ({ ...a }))
        } as any);

        // Mark the goods-receipt consumed so the feed reflects that this batch
        // was turned into a passport (best-effort; the passport row is the SoT).
        await UPDATE.entity('mocksap.GoodsReceipts').set({ status: 'consumed' }).where({ batchId });

        // 6. Return the action result, incl. the QR as a data-URL PNG.
        const qrCodePng = await QRCode.toDataURL(qrCodeUrl, { width: 320, margin: 1 });
        return { passportId, attestationTxHash, qrCodeUrl, qrCodePng };
    };

    /** Supplier resolution by on-chain payloadHash → identity + verification + link. */
    private resolveByHash = async (req: cds.Request) => {
        const raw = String((req.data as { payloadHash?: string }).payloadHash ?? '').replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(raw)) return req.reject(400, 'payloadHash must be 32-byte hex');
        const row = await SELECT.one.from(Passports)
            .columns('passportId', 'manufacturerId', 'model', 'batteryCategory', 'contractAddress', 'attestationTxHash', 'status', 'payloadHash')
            .where({ payloadHash: raw });
        if (!row) return req.reject(404, 'no battery for that payloadHash');
        const demoHost = process.env.PASSPORT_DEMO_HOST ?? 'https://passport.example';
        return {
            passportId: row.passportId,
            payloadHash: raw,
            manufacturerId: row.manufacturerId,
            model: row.model,
            batteryCategory: row.batteryCategory,
            contractAddress: row.contractAddress,
            attestationTxHash: row.attestationTxHash,
            status: row.status,
            // DB-state assertion only (anchored + tx present); NOT a live on-chain
            // re-verification. A verifier resolves attestationTxHash to confirm.
            locallyAnchored: row.status === 'anchored' && !!row.attestationTxHash,
            viewerUrl: `${demoHost}/resolve/${raw}`
        };
    };

    /**
     * Live on-chain verification for the public viewer (anonymous). Reads the
     * vault state through the indexer via NIGHTGATE `verifyAttestationState`
     * (crawler-free), so it works on a read-only public host without a wallet.
     *
     * NightgateService is service-level `@requires: 'authenticated-user'`, but
     * this check is public by design (anyone holding the QR may verify), so the
     * in-process call runs under a fixed technical principal. A failed or
     * unreachable ledger read yields `verified:false`, never a 5xx.
     */
    private verifyOnChain = async (req: cds.Request) => {
        const passportId = String((req.data as { passportId?: string }).passportId ?? '').trim();
        if (!passportId) return req.reject(400, 'passportId is required');
        const row = await SELECT.one.from(Passports)
            .columns('passportId', 'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'status')
            .where({ passportId });
        if (!row) return req.reject(404, `passport '${passportId}' not found`);

        const norm = (h: unknown) => String(h ?? '').replace(/^0x/, '').toLowerCase();
        const payloadHash = norm(row.payloadHash);
        const contractAddress = norm(row.contractAddress);

        // A row anchored on a DIFFERENT Midnight network than this server queries
        // needs the `network` override on NIGHTGATE's verifyAttestationState.
        // Feature-detect it on the loaded model: on plugin versions without it
        // the doomed read is skipped and the caller shows the honest reason.
        const serverNetwork = effectiveNetwork();
        const anchorNetwork = (row as Record<string, unknown>).anchorNetwork as string | null ?? null;
        const crossNetwork = !!anchorNetwork && anchorNetwork !== serverNetwork;
        const canOverride = !!(cds.model?.definitions?.['NightgateService.verifyAttestationState'] as any)?.params?.network;

        let verified = false;
        let checkedNetwork: string | null = null;
        const peerBase = crossNetwork && anchorNetwork ? verifyPeers()[anchorNetwork] : undefined;
        if (payloadHash && contractAddress && (!crossNetwork || canOverride)) {
            checkedNetwork = crossNetwork ? anchorNetwork : serverNetwork;
            try {
                const nightgate = await cds.connect.to('NightgateService');
                const verifier = new (cds.User as any)({ id: 'passport-verifier' });
                const res: any = await (nightgate as any).tx({ user: verifier }, (tx: any) =>
                    tx.send('verifyAttestationState', {
                        contractAddress,
                        payloadHash,
                        compiledArtifactRef: 'attestation-vault',
                        ...(crossNetwork ? { network: anchorNetwork } : {})
                    }));
                verified = res?.verified === true;
            } catch { /* indexer unreachable or contract unknown: stay unverified */ }
        } else if (payloadHash && contractAddress && peerBase) {
            // No plugin-side network override, but a PEER instance configured for
            // the row's network exists (PASSPORT_VERIFY_PEERS): delegate the live
            // check to it server-side over its public API. On any peer failure
            // the read counts as NOT performed (checkedNetwork stays null), so
            // the UI shows the honest "cannot check here" instead of a false
            // negative.
            try {
                const url = `${peerBase}/api/v1/passport/verifyOnChain(passportId=${encodeURIComponent(`'${passportId.replace(/'/g, "''")}'`)})`;
                // Generous timeout: the peer's FIRST state read builds its
                // provider bundle (ESM import + indexer handshake) and can take
                // north of 30s cold; warm reads answer in a few seconds.
                const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
                if (!r.ok) throw new Error(`peer ${r.status}`);
                const b: any = await r.json();
                verified = b?.verified === true;
                checkedNetwork = typeof b?.checkedNetwork === 'string' ? b.checkedNetwork : anchorNetwork;
            } catch (e: any) {
                cds.log('passport').warn(`peer verify (${anchorNetwork}) failed:`, e?.message ?? e);
                verified = false;
                checkedNetwork = null;
            }
        }
        return {
            passportId: row.passportId,
            status: row.status,
            verified,
            payloadHash: payloadHash || null,
            contractAddress: contractAddress || null,
            anchorNetwork,
            serverNetwork,
            checkedNetwork,
            attestationTxHash: row.attestationTxHash ?? null,
            explorerUrl: explorerTxUrl(row.attestationTxHash, anchorNetwork),
            checkedAt: new Date().toISOString()
        };
    };

    /**
     * Public anchor explorer: all passports with their anchoring state, anchored
     * first, newest first within a status. DB-only (no ledger reads here); the
     * UI verifies rows live via verifyOnChain on demand.
     */
    private anchorExplorer = async () => {
        const rows = await SELECT.from(Passports)
            .columns('passportId', 'model', 'manufacturerId', 'batteryCategory', 'status',
                'manufactureDate', 'weightKg', 'performanceClass', 'qrCodeUrl',
                'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'createdAt')
            .orderBy('createdAt desc');
        const norm = (h: unknown) => String(h ?? '').replace(/^0x/, '').toLowerCase();
        const rank: Record<string, number> = { anchored: 0, anchoring: 1, failed: 2, draft: 3 };
        return (rows as Record<string, unknown>[])
            .sort((a, b) => (rank[String(a.status)] ?? 9) - (rank[String(b.status)] ?? 9))
            .map((r) => ({
                passportId: r.passportId,
                model: r.model,
                manufacturerId: r.manufacturerId,
                batteryCategory: r.batteryCategory,
                manufactureDate: r.manufactureDate ?? null,
                weightKg: r.weightKg ?? null,
                performanceClass: r.performanceClass ?? null,
                qrCodeUrl: r.qrCodeUrl ?? null,
                status: r.status,
                payloadHash: r.payloadHash ? norm(r.payloadHash) : null,
                contractAddress: r.contractAddress ? norm(r.contractAddress) : null,
                anchorNetwork: r.anchorNetwork ?? null,
                attestationTxHash: r.attestationTxHash ?? null,
                explorerUrl: explorerTxUrl(r.attestationTxHash as string | null, r.anchorNetwork as string | null),
                createdAt: r.createdAt ?? null
            }));
    };

    /** Build a W3C-VC-style Battery Passport Credential (JSON) for a supplier. */
    private passportCredential = async (req: cds.Request) => {
        const raw = String((req.data as { payloadHash?: string }).payloadHash ?? '').replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(raw)) return req.reject(400, 'payloadHash must be 32-byte hex');
        const p = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'manufacturerId', 'model', 'batteryCategory', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'status', 'payloadHash')
            .where({ payloadHash: raw });
        if (!p) return req.reject(404, 'no battery for that payloadHash');
        const proofs = await SELECT.from(PredicateProofLog)
            .columns('sourceField', 'predicate', 'threshold', 'unit', 'txHash', 'result', 'status')
            .where({ passport_ID: p.ID, status: 'succeeded' });
        const explorer = (h: unknown) => explorerTxUrl(h as string | null, (p as Record<string, unknown>).anchorNetwork as string | null);
        const credential = {
            '@context': ['https://www.w3.org/ns/credentials/v2', 'https://catena-x.net/schema/pac/v1'],
            type: ['VerifiableCredential', 'BatteryPassportCredential'],
            id: `urn:bpass:${p.passportId}`,
            profile: 'Catena-X CX-0143 Battery Passport',
            issuanceDate: new Date().toISOString(),
            credentialSubject: {
                passportId: p.passportId,
                standard: 'EU 2023/1542 Annex XIII',
                batteryCategory: p.batteryCategory,
                model: p.model,
                manufacturerId: p.manufacturerId,
                payloadHash: raw,
                attestation: {
                    contractAddress: p.contractAddress ? `0x${String(p.contractAddress).replace(/^0x/, '')}` : null,
                    transactionHash: p.attestationTxHash ? `0x${String(p.attestationTxHash).replace(/^0x/, '')}` : null,
                    status: p.status,
                    // DB-state assertion only; a verifier resolves transactionHash on-chain.
                    locallyAnchored: p.status === 'anchored' && !!p.attestationTxHash,
                    explorer: explorer(p.attestationTxHash)
                },
                predicateProofs: (proofs as Record<string, unknown>[]).map((pr) => ({
                    sourceField: pr.sourceField,
                    claim: `${pr.sourceField} ${pr.predicate} ${pr.threshold}${pr.unit ? ' ' + pr.unit : ''}`,
                    operator: pr.predicate,
                    threshold: pr.threshold,
                    unit: pr.unit,
                    valueDisclosed: false,
                    result: pr.result,
                    transactionHash: pr.txHash ? `0x${String(pr.txHash).replace(/^0x/, '')}` : null,
                    verificationModel: 'indexer-trust',
                    explorer: explorer(pr.txHash)
                }))
            }
        };
        return JSON.stringify(credential, null, 2);
    };

    /** Register a dataspace partner (DID/BPN) + bind DID → granteeId for reads. */
    private registerPartner = async (req: cds.Request) => {
        const { did, name, role, secret } = req.data as
            { did?: string; name?: string; role?: string; secret?: string };
        const d = String(did ?? '').trim();
        if (!d) return req.reject(400, 'did is required');
        if (!secret) return req.reject(400, 'secret is required');
        const r = role === 'authority' ? 'authority' : 'recycler';
        const granteeId = granteeIdForDid(d);

        // A DID/BPN is claimed once. Re-registration must NOT rotate the secret of
        // an existing partner: that would let anyone reset the credential of a
        // partner who already holds grants and then read as them. Reject instead;
        // a change to an existing partner is an out-of-band / admin operation. The
        // action itself is producer-gated (@requires in passport-service.cds), so
        // registration is producer-led, not anonymous self-service.
        const existing = await SELECT.one.from(Partners).where({ did: d });
        if (existing) return req.reject(409, `partner '${d}' already registered`);
        await INSERT.into(Partners).entries({ did: d, name, role: r, granteeId, secret } as any);

        // Bind DID → granteeId in the plugin's GranteeIdentities (global scope),
        // so granteesOf(req) resolves this partner at read time. Idempotent.
        const now = new Date().toISOString();
        const gi: any = await cds.db.run(
            SELECT.one.from('midnight.GranteeIdentities').where({ userId: d, scope: null })
        );
        if (gi) {
            await cds.db.run(UPDATE.entity('midnight.GranteeIdentities')
                .set({ granteeId, bindingKind: 'did', modifiedAt: now }).where({ ID: gi.ID }));
        } else {
            await cds.db.run(INSERT.into('midnight.GranteeIdentities').entries({
                ID: cds.utils.uuid(), userId: d, granteeId, bindingKind: 'did', scope: null,
                createdAt: now, modifiedAt: now
            }));
        }
        return { did: d, name, role: r, granteeId };
    };
}

// --- Batch source

/**
 * Resolve a goods-receipt batch by id from the mock SAP feed
 * (mocksap.GoodsReceipts, served by MockSapService). Rows are emitted by the
 * deterministic generator, not hard-coded; rowToBatch parses the stored public
 * header + shielded payload back into the batch shape generatePassport consumes.
 * Returns null when the batch id is unknown.
 */
async function resolveBatch(batchId: string): Promise<Batch | null> {
    const row = await SELECT.one.from('mocksap.GoodsReceipts').where({ batchId });
    if (!row) return null;
    return rowToBatch(row as GoodsReceiptRow);
}

