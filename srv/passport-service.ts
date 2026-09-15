import cds from '@sap/cds';
import { Passport, Passports, PredicateProofLog, Partners } from '#cds-models/passport';
import { effectiveNetwork, explorerTxUrl, verifyPeers, fieldKeyHex, blake2b256Hex } from './lib/passport-anchor';
import { recordSelectorArgs } from './lib/state-verify';
import { readState, verifyNetworkOverrideAvailable } from './lib/verify-reader';
import { granteeIdForDid } from './lib/grantee';
import { claimSetById, setLabelFor } from './lib/claim-sets';
import { restrictedProbe } from './lib/query-guard';

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
// Tier model + redaction rules are extracted to @odatano/dpp-sdk (shared with
// DAYPASS); only the CAP wiring (role resolution, on-chain grant lookup, CQN
// probing guards) and the chain-specific authority field list live here.
import {
    maxTier, levelToTier, attributeVisible, strip,
    redactBattery, redactRecycled,
    BATTERY_AUTHORITY_FIELDS, RECYCLED_AUTHORITY_FIELDS,
    redactPassport as redactPassportShared, type Tier
} from '@odatano/dpp-sdk/tier';

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

/**
 * Fields on Passports beyond Annex XIII Point 1. Authority-only lineage.
 * `owner` is the operator's shielded wallet address: publishing it would link
 * every passport of one producer (and every demo visitor's Midnight identity)
 * on a surface whose whole point is unlinkability.
 */
const PASSPORT_AUTHORITY_FIELDS = [
    'payloadHash', 'passportIdHash', 'contractAddress', 'attestationTxHash', 'attestation', 'attestation_ID', 'owner'
] as const;

/** Redact one Passports row (and any expanded children) for the given tier. */
function redactPassport(row: Record<string, unknown>, tier: Tier): void {
    redactPassportShared(row, tier, PASSPORT_AUTHORITY_FIELDS);
}

/**
 * Reject a read whose $filter / $orderby / $apply touches a column the tier
 * may not see. Without this, redacting rows AFTER the database read is not a
 * disclosure boundary at all: `$filter=carbonFootprintKgCO2 lt 3000&$count=true`
 * turns the row COUNT into an oracle that reconstructs the exact confidential
 * value the ZK predicate exists to hide (verified against the live host).
 */
function rejectRestrictedProbing(req: cds.Request, restricted: readonly string[]): void {
    const hit = restrictedProbe((req.query as any)?.SELECT, restricted);
    if (hit) req.reject(403, `'${hit}' is not readable at your disclosure tier and cannot be filtered, sorted or aggregated on`);
}

/**
 * Restrict a child-entity read to nothing at all. The tier sees no row of this
 * entity, so returning zero rows is the honest answer; serving stripped-empty
 * rows would still publish their COUNT. `ID` is a non-null key, so `ID is null`
 * is an always-false predicate on both SQLite and PostgreSQL.
 */
function restrictToNothing(req: cds.Request): void {
    (req.query as any).where({ ID: null });
}

function asRows(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) return data as Record<string, unknown>[];
    if (data && typeof data === 'object') return [data as Record<string, unknown>];
    return [];
}

/**
 * PassportService implementation: the public read/verify surface (tier-gated
 * reads, anonymous on-chain verification, QR resolution, publish/ingest).
 * Passport creation lives in ProducerService.createPassport.
 */
export default class PassportService extends cds.ApplicationService {
    override async init(): Promise<void> {
        this.on('resolveByHash', this.resolveByHash);
        this.on('passportCredential', this.passportCredential);
        this.on('registerPartner', this.registerPartner);
        this.on('verifyOnChain', this.verifyOnChain);
        this.on('verifyAnchorVersion', this.verifyAnchorVersion);
        this.on('verifyClaimOnChain', this.verifyClaimOnChain);
        this.on('verifyMembershipClaimOnChain', this.verifyMembershipClaimOnChain);
        this.on('verifyVersionIntegrityOnChain', this.verifyVersionIntegrityOnChain);
        this.on('verifyVersionChangeOnChain', this.verifyVersionChangeOnChain);
        this.on('anchorHistory', this.anchorHistory);
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
        //
        // The boundary is enforced BEFORE the database: a consumer gets no row
        // at all (an empty row still leaks through $count), and a recycler may
        // not filter, sort or aggregate on the authority-only columns. The
        // after-READ redaction below stays as defense in depth.
        this.before('READ', 'Batteries', (req) => {
            const tier = localTierOf(req);
            if (tier === 'consumer') return restrictToNothing(req);
            if (tier !== 'authority') rejectRestrictedProbing(req, BATTERY_AUTHORITY_FIELDS);
        });
        this.after('READ', 'Batteries', (data, req) => {
            const tier = localTierOf(req);
            asRows(data).forEach((row) => redactBattery(row, tier));
        });
        this.before('READ', 'RecycledMaterials', (req) => {
            const tier = localTierOf(req);
            if (tier === 'consumer') return restrictToNothing(req);
            if (tier !== 'authority') rejectRestrictedProbing(req, RECYCLED_AUTHORITY_FIELDS);
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
        // DiligenceDoc is authority-only in full; below-tier requests get nothing
        // (not even a row count, hence the before-READ restriction).
        this.before('READ', 'DiligenceDoc', (req) => {
            if (localTierOf(req) !== 'authority') restrictToNothing(req);
        });
        this.after('READ', 'DiligenceDoc', (data, req) => {
            if (localTierOf(req) === 'authority') return;
            asRows(data).forEach((row) => strip(row, Object.keys(row)));
        });

        return super.init();
    }

    /** Supplier resolution by on-chain payloadHash → identity + verification + link. */
    private resolveByHash = async (req: cds.Request) => {
        const raw = String((req.data as { payloadHash?: string }).payloadHash ?? '').replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(raw)) return req.reject(400, 'payloadHash must be 32-byte hex');
        let row = await SELECT.one.from(Passports)
            .columns('passportId', 'manufacturerId', 'model', 'batteryCategory', 'contractAddress', 'attestationTxHash', 'status', 'payloadHash')
            .where({ payloadHash: raw });
        // A superseded anchor version (re-anchoring) still resolves: the hash
        // identifies the passport, `version` tells the caller it is historical.
        let resolvedVersion: number | null = null;
        if (!row) {
            const v: any = await SELECT.one.from('passport.PassportAnchorVersions')
                .columns('passport_ID', 'version', 'attestationTxHash')
                .where({ payloadHash: raw });
            if (v?.passport_ID) {
                resolvedVersion = Number(v.version);
                row = await SELECT.one.from(Passports)
                    .columns('passportId', 'manufacturerId', 'model', 'batteryCategory', 'contractAddress', 'status', 'payloadHash')
                    .where({ ID: v.passport_ID });
                if (row) (row as any).attestationTxHash = v.attestationTxHash;
            }
        }
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
            viewerUrl: `${demoHost}/resolve/${raw}`,
            version: resolvedVersion
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
            .columns('passportId', 'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'status', 'attesterId', 'passportIdHash')
            .where({ passportId });
        if (!row) return req.reject(404, `passport '${passportId}' not found`);

        const norm = (h: unknown) => String(h ?? '').replace(/^0x/, '').toLowerCase();
        const payloadHash = norm(row.payloadHash);
        const contractAddress = norm(row.contractAddress);
        // The record is named by its attester; a row without one (published
        // before the stamp, or anchored by a wallet) resolves through the
        // bound document id, blake2b of the passport id.
        const selector = recordSelectorArgs({
            contractAddress, payloadHash, attesterId: (row as any).attesterId,
            documentId: (row as any).passportIdHash || blake2b256Hex(String(row.passportId))
        });

        // A row anchored on a DIFFERENT Midnight network than this server queries
        // needs the `network` override on NIGHTGATE's verifyAttestationState.
        // Feature-detect it on the loaded model: on plugin versions without it
        // the doomed read is skipped and the caller shows the honest reason.
        const serverNetwork = effectiveNetwork();
        const anchorNetwork = (row as Record<string, unknown>).anchorNetwork as string | null ?? null;
        const crossNetwork = !!anchorNetwork && anchorNetwork !== serverNetwork;
        const canOverride = verifyNetworkOverrideAvailable();

        let verified = false;
        let checkedNetwork: string | null = null;
        let attesterId: string | null = (row as any).attesterId ? norm((row as any).attesterId) : null;
        let bindingRegistered: boolean | null = null;
        const peerBase = crossNetwork && anchorNetwork ? verifyPeers()[anchorNetwork] : undefined;
        if (selector && (!crossNetwork || canOverride)) {
            checkedNetwork = crossNetwork ? anchorNetwork : serverNetwork;
            try {
                const res: any = await readState('verifyAttestationState', {
                    ...selector,
                    compiledArtifactRef: 'attestation-vault',
                    ...(crossNetwork ? { network: anchorNetwork } : {})
                });
                verified = res?.verified === true;
                if (typeof res?.attesterId === 'string' && /^[0-9a-f]{64}$/i.test(res.attesterId)) attesterId = norm(res.attesterId);
                if (typeof res?.bindingRegistered === 'boolean') bindingRegistered = res.bindingRegistered;
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
            checkedAt: new Date().toISOString(),
            attesterId,
            bindingRegistered
        };
    };

    /**
     * Live verification of a superseded anchor version: same vault read as
     * verifyOnChain, but against the archived version's payload hash. No peer
     * delegation here; a cross-network row without the plugin network override
     * honestly reports checkedNetwork:null.
     */
    private verifyAnchorVersion = async (req: cds.Request) => {
        const { passportId: pidRaw, version } = req.data as { passportId?: string; version?: number };
        const passportId = String(pidRaw ?? '').trim();
        if (!passportId) return req.reject(400, 'passportId is required');
        if (version == null || !Number.isInteger(Number(version))) return req.reject(400, 'version is required');
        const row: any = await SELECT.one.from(Passports).columns('ID', 'passportId', 'passportIdHash').where({ passportId });
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const v: any = await SELECT.one.from('passport.PassportAnchorVersions')
            .columns('version', 'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'attesterId')
            .where({ passport_ID: row.ID, version: Number(version) });
        if (!v) return req.reject(404, `passport '${passportId}' has no anchor version ${version}`);

        const norm = (h: unknown) => String(h ?? '').replace(/^0x/, '').toLowerCase();
        const payloadHash = norm(v.payloadHash);
        const contractAddress = norm(v.contractAddress);
        const serverNetwork = effectiveNetwork();
        const anchorNetwork = (v.anchorNetwork as string | null) ?? null;
        const crossNetwork = !!anchorNetwork && anchorNetwork !== serverNetwork;
        const canOverride = verifyNetworkOverrideAvailable();
        // A superseded version is no longer the bound one, so only its
        // attester names its record; the document-id fallback would resolve
        // the current version and answer false (the payload differs).
        const selector = recordSelectorArgs({
            contractAddress, payloadHash, attesterId: v.attesterId,
            documentId: row.passportIdHash || blake2b256Hex(String(row.passportId))
        });

        let verified = false;
        let checkedNetwork: string | null = null;
        if (selector && (!crossNetwork || canOverride)) {
            checkedNetwork = crossNetwork ? anchorNetwork : serverNetwork;
            try {
                const res: any = await readState('verifyAttestationState', {
                    ...selector,
                    compiledArtifactRef: 'attestation-vault',
                    ...(crossNetwork ? { network: anchorNetwork } : {})
                });
                verified = res?.verified === true;
            } catch { /* indexer unreachable or contract unknown: stay unverified */ }
        }
        return {
            passportId: row.passportId,
            version: Number(v.version),
            verified,
            payloadHash: payloadHash || null,
            contractAddress: contractAddress || null,
            anchorNetwork,
            serverNetwork,
            checkedNetwork,
            attestationTxHash: v.attestationTxHash ?? null,
            explorerUrl: explorerTxUrl(v.attestationTxHash, anchorNetwork),
            checkedAt: new Date().toISOString()
        };
    };

    /**
     * Anchor version history (anonymous; only anchor metadata that already
     * lives on-chain, never the ciphers). Superseded versions first, then the
     * current anchor as the last entry.
     */
    private anchorHistory = async (req: cds.Request) => {
        const passportId = String((req.data as { passportId?: string }).passportId ?? '').trim();
        if (!passportId) return req.reject(400, 'passportId is required');
        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'status')
            .where({ passportId });
        if (!row) return req.reject(404, `passport '${passportId}' not found`);
        const versions: any[] = await SELECT.from('passport.PassportAnchorVersions')
            .columns('version', 'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'anchoredAt', 'reason')
            .where({ passport_ID: row.ID })
            .orderBy('version' as any);
        const out = (versions ?? []).map((v) => ({
            version: Number(v.version),
            current: false,
            payloadHash: v.payloadHash ?? null,
            contractAddress: v.contractAddress ?? null,
            anchorNetwork: v.anchorNetwork ?? null,
            attestationTxHash: v.attestationTxHash ?? null,
            explorerUrl: explorerTxUrl(v.attestationTxHash, v.anchorNetwork ?? null),
            anchoredAt: v.anchoredAt ? new Date(v.anchoredAt).toISOString() : null,
            reason: v.reason ?? null
        }));
        if (row.status === 'anchored' || row.status === 'anchoring') {
            out.push({
                version: out.length ? out[out.length - 1].version + 1 : 1,
                current: true,
                payloadHash: row.payloadHash ?? null,
                contractAddress: row.contractAddress ?? null,
                anchorNetwork: row.anchorNetwork ?? null,
                attestationTxHash: row.attestationTxHash ?? null,
                explorerUrl: explorerTxUrl(row.attestationTxHash, row.anchorNetwork ?? null),
                anchoredAt: null,
                reason: null
            });
        }
        return out;
    };

    /**
     * Public anchor explorer: all passports with their anchoring state, anchored
     * first, newest first within a status. DB-only (no ledger reads here); the
     * UI verifies rows live via verifyOnChain on demand.
     */
    /**
     * Anonymous LIVE check of one proven ZK claim: does the vault's on-chain
     * state record a true result for the claim key (payloadHash, field,
     * predicate, threshold)? Crawler-free via NIGHTGATE verifyPredicateState;
     * `threshold` arrives in RAW units and is scaled x1000 to the same integer
     * the circuit hashed into the claim key. Mirrors verifyOnChain: technical
     * user for the plugin call, network override for cross-network rows,
     * failures degrade to verified:false (never 5xx).
     */
    private verifyClaimOnChain = async (req: cds.Request) => {
        const { passportId, sourceField, predicate, threshold } = req.data as {
            passportId?: string; sourceField?: string; predicate?: string; threshold?: number;
        };
        const pred = predicate === 'greaterOrEqual' ? 'greaterOrEqual' : 'lessOrEqual';
        const thresholdScaled = Math.round(Number(threshold ?? 0) * 1000);
        const probe = await this.probeClaimOnChain(req, {
            passportId, sourceField,
            proofLogWhere: { predicate: pred, threshold: thresholdScaled },
            claimArgs: { predicate: pred, threshold: thresholdScaled }
        });
        if (!probe) return; // req already rejected
        return {
            passportId: probe.passportId,
            sourceField,
            predicate: pred,
            threshold: Number(threshold ?? 0),
            ...probe.envelope
        };
    };

    /**
     * Anonymous live check of a set-membership claim (sibling of
     * verifyClaimOnChain, which stays signature-stable for deployed callers:
     * CAP V4 functions require every declared param in the URL, so a new kind
     * gets a NEW function). Claim key = (payloadHash, fieldKey, setRoot).
     */
    private verifyMembershipClaimOnChain = async (req: cds.Request) => {
        const { passportId, sourceField, setRoot } = req.data as {
            passportId?: string; sourceField?: string; setRoot?: string;
        };
        const root = String(setRoot ?? '').replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(root)) return req.reject(400, 'setRoot must be 32-byte hex (64 chars)');
        const probe = await this.probeClaimOnChain(req, {
            passportId, sourceField,
            proofLogWhere: { predicate: 'setMembership', setRoot: root },
            claimArgs: { predicate: 'setMembership', setRoot: root },
            // A plugin without the membership kind cannot check this claim;
            // skip the live read and stay honestly unverified.
            requireModelParam: 'setRoot'
        });
        if (!probe) return; // req already rejected
        return {
            passportId: probe.passportId,
            sourceField,
            predicate: 'setMembership',
            setRoot: root,
            ...probe.envelope
        };
    };

    /**
     * Anonymous live check of a proven version-integrity claim. Deliberately
     * NOT routed through probeClaimOnChain: that helper probes candidate
     * payload hashes for a claim about ONE document, while a cross-root claim
     * names both documents explicitly, so there is nothing to guess. Both
     * versions are anchored on the same vault by construction (the prover
     * refuses otherwise), so the row's contract is the one to read.
     */
    private verifyVersionIntegrityOnChain = async (req: cds.Request) => {
        const { passportId, payloadHashA, payloadHashB, allowedMask } = req.data as {
            passportId?: string; payloadHashA?: string; payloadHashB?: string; allowedMask?: number;
        };
        const mask = Number(allowedMask ?? 0);
        if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff) {
            return req.reject(400, 'allowedMask must be a 16-bit integer');
        }
        const probe = await this.probeCrossRootClaim(req, {
            passportId, payloadHashA, payloadHashB, kind: 'documentIntegrity', bound: mask
        });
        if (!probe) return; // req already rejected
        return { ...probe, allowedMask: mask, predicate: 'documentIntegrity' };
    };

    private verifyVersionChangeOnChain = async (req: cds.Request) => {
        const { passportId, payloadHashA, payloadHashB, minChangedSlots } = req.data as {
            passportId?: string; payloadHashA?: string; payloadHashB?: string; minChangedSlots?: number;
        };
        const k = Number(minChangedSlots ?? 0);
        if (!Number.isInteger(k) || k < 1 || k > 16) {
            return req.reject(400, 'minChangedSlots must be an integer 1..16');
        }
        const probe = await this.probeCrossRootClaim(req, {
            passportId, payloadHashA, payloadHashB, kind: 'documentDiff', bound: k
        });
        if (!probe) return; // req already rejected
        return { ...probe, minChangedSlots: k, predicate: 'documentDiff' };
    };

    /**
     * Shared probe of the two cross-root verifiers. Deliberately NOT routed
     * through probeClaimOnChain: that helper guesses candidate payload hashes
     * for a claim about ONE document, while a cross-root claim names both
     * documents explicitly, so there is nothing to guess. Both versions are
     * anchored on the same vault by construction (the prover refuses
     * otherwise), so the row's contract is the one to read.
     */
    private async probeCrossRootClaim(req: cds.Request, o: {
        passportId?: string; payloadHashA?: string; payloadHashB?: string;
        kind: 'documentIntegrity' | 'documentDiff'; bound: number;
    }) {
        const norm = (h: unknown) => String(h ?? '').replace(/^0x/, '').toLowerCase();
        const pid = String(o.passportId ?? '').trim();
        const hashA = norm(o.payloadHashA);
        const hashB = norm(o.payloadHashB);
        if (!pid) { req.reject(400, 'passportId is required'); return null; }
        if (!/^[0-9a-f]{64}$/.test(hashA) || !/^[0-9a-f]{64}$/.test(hashB)) {
            req.reject(400, 'payloadHashA and payloadHashB must be 32-byte hex (64 chars)');
            return null;
        }
        const row: any = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'contractAddress', 'anchorNetwork', 'payloadHash', 'attesterId')
            .where({ passportId: pid });
        if (!row) { req.reject(404, `passport '${pid}' not found`); return null; }

        const contractAddress = norm(row.contractAddress);
        const serverNetwork = effectiveNetwork();
        const anchorNetwork = (row.anchorNetwork as string | null) ?? null;
        const crossNetwork = !!anchorNetwork && anchorNetwork !== serverNetwork;
        const params = (cds.model?.definitions?.['NightgateService.verifyPredicateState'] as any)?.params;
        const canOverride = !!params?.network;
        // A plugin without the cross-root params cannot answer this at all;
        // stay honestly unverified rather than sending args it would reject.
        const kindSupported = !!params?.payloadHashB
            && !!(o.kind === 'documentDiff' ? params?.k : params?.allowedMask);
        // Each record is its attester's: the current row's and the archived
        // versions' attesters, by payload hash.
        const attesterByHash = new Map<string, string>();
        if (row.attesterId) attesterByHash.set(norm(row.payloadHash), norm(row.attesterId));
        const versions: any[] = await SELECT.from('passport.PassportAnchorVersions')
            .columns('payloadHash', 'attesterId').where({ passport_ID: row.ID });
        for (const v of versions ?? []) if (v.attesterId) attesterByHash.set(norm(v.payloadHash), norm(v.attesterId));
        const attesterIdA = attesterByHash.get(hashA);
        const attesterIdB = attesterByHash.get(hashB);

        let verified = false;
        let checkedNetwork: string | null = null;
        if (contractAddress && kindSupported && attesterIdA && attesterIdB && (!crossNetwork || canOverride)) {
            checkedNetwork = crossNetwork ? anchorNetwork : serverNetwork;
            try {
                const res: any = await readState('verifyPredicateState', {
                    contractAddress,
                    attesterId: attesterIdA,
                    payloadHash: hashA,
                    payloadHashB: hashB,
                    ...(attesterIdB !== attesterIdA ? { attesterIdB } : {}),
                    predicate: o.kind,
                    ...(o.kind === 'documentDiff' ? { k: o.bound } : { allowedMask: o.bound }),
                    compiledArtifactRef: 'attestation-vault',
                    ...(crossNetwork ? { network: anchorNetwork } : {})
                });
                verified = res?.verified === true;
            } catch { /* indexer unreachable or contract unknown: stay unverified */ }
        }
        return {
            passportId: row.passportId,
            payloadHashA: hashA, payloadHashB: hashB,
            verified, anchorNetwork, serverNetwork, checkedNetwork,
            checkedAt: new Date().toISOString()
        };
    }

    /**
     * Shared probe core of the anonymous claim verifiers: resolve the row,
     * pick the candidate payload hashes (the stamped hash from the matching
     * proof-log row first; pre-feature rows probe the current hash and the
     * superseded versions, newest first, capped at 5, so old claims still
     * verify after a re-anchor), then ask NIGHTGATE's crawler-free
     * verifyPredicateState per candidate with the claim-kind-specific args.
     * One implementation for every claim kind; failures degrade to
     * verified:false, never 5xx. Returns null after rejecting the request.
     */
    private async probeClaimOnChain(req: cds.Request, o: {
        passportId?: string; sourceField?: string;
        proofLogWhere: Record<string, unknown>;
        claimArgs: Record<string, unknown>;
        requireModelParam?: string;
    }) {
        const pid = String(o.passportId ?? '').trim();
        if (!pid) { req.reject(400, 'passportId is required'); return null; }
        if (!o.sourceField) { req.reject(400, 'sourceField is required'); return null; }
        const row = await SELECT.one.from(Passports)
            .columns('ID', 'passportId', 'payloadHash', 'contractAddress', 'anchorNetwork', 'status', 'attesterId')
            .where({ passportId: pid });
        if (!row) { req.reject(404, `passport '${pid}' not found`); return null; }

        const norm = (h: unknown) => String(h ?? '').replace(/^0x/, '').toLowerCase();
        const contractAddress = norm(row.contractAddress);
        const serverNetwork = effectiveNetwork();
        const anchorNetwork = (row as Record<string, unknown>).anchorNetwork as string | null ?? null;
        const crossNetwork = !!anchorNetwork && anchorNetwork !== serverNetwork;
        const params = (cds.model?.definitions?.['NightgateService.verifyPredicateState'] as any)?.params;
        const canOverride = !!params?.network;
        const kindSupported = !o.requireModelParam || !!params?.[o.requireModelParam];

        // On-chain claim keys live per (CONTRACT, payloadHash): after a
        // same-network vault redeploy a re-anchored row points at the NEW
        // vault while its old claims were proven on the OLD one, whose
        // address the anchor-version rows preserve. Candidates are therefore
        // (payloadHash, contractAddress) PAIRS: the stamped hash probes the
        // current contract first and then each superseded version's own
        // contract; pre-stamp rows probe hash+contract per version.
        const versions: any[] = await SELECT.from('passport.PassportAnchorVersions')
            .columns('payloadHash', 'contractAddress', 'attesterId')
            .where({ passport_ID: (row as any).ID }).orderBy('version desc' as any);
        const proofRow: any = await SELECT.one.from(PredicateProofLog)
            .columns('payloadHash', 'attesterId')
            .where({ passport_ID: (row as any).ID, sourceField: String(o.sourceField), ...o.proofLogWhere, status: 'succeeded', result: true })
            .orderBy('createdAt desc' as any);
        // A claim key embeds the RECORD key (attester + payload): every
        // candidate needs its attester. The stamped proof row names it
        // directly; otherwise the row's or the version's attester applies.
        const attesterByHash = new Map<string, string>();
        if ((row as any).attesterId) attesterByHash.set(norm(row.payloadHash), norm((row as any).attesterId));
        for (const v of versions ?? []) if (v.attesterId) attesterByHash.set(norm(v.payloadHash), norm(v.attesterId));
        const seen = new Set<string>();
        const candidates: { payloadHash: string; contractAddress: string; attesterId: string }[] = [];
        const push = (h: string, c: string, a?: string) => {
            const attester = a || attesterByHash.get(h) || '';
            if (!h || !c || !attester || seen.has(`${h}|${c}|${attester}`)) return;
            seen.add(`${h}|${c}|${attester}`);
            candidates.push({ payloadHash: h, contractAddress: c, attesterId: attester });
        };
        if (proofRow?.payloadHash) {
            const stamped = norm(proofRow.payloadHash);
            const stampedAttester = proofRow.attesterId ? norm(proofRow.attesterId) : undefined;
            push(stamped, contractAddress, stampedAttester);
            for (const v of versions ?? []) push(stamped, norm(v.contractAddress) || contractAddress, stampedAttester);
        } else {
            push(norm(row.payloadHash), contractAddress);
            for (const v of versions ?? []) push(norm(v.payloadHash), norm(v.contractAddress) || contractAddress);
        }
        const probes = candidates.slice(0, 5);

        let verified = false;
        let checkedNetwork: string | null = null;
        if (probes.length && contractAddress && kindSupported && (!crossNetwork || canOverride)) {
            checkedNetwork = crossNetwork ? anchorNetwork : serverNetwork;
            try {
                for (const cand of probes) {
                    const res: any = await readState('verifyPredicateState', {
                        contractAddress: cand.contractAddress,
                        attesterId: cand.attesterId,
                        payloadHash: cand.payloadHash,
                        fieldKey: fieldKeyHex(String(o.sourceField)),
                        ...o.claimArgs,
                        compiledArtifactRef: 'attestation-vault',
                        ...(crossNetwork ? { network: anchorNetwork } : {})
                    });
                    if (res?.verified === true) { verified = true; break; }
                }
            } catch { /* indexer unreachable or contract unknown: stay unverified */ }
        }
        return {
            passportId: row.passportId,
            envelope: {
                verified,
                anchorNetwork,
                serverNetwork,
                checkedNetwork,
                checkedAt: new Date().toISOString()
            }
        };
    }

    private anchorExplorer = async () => {
        const rows = await SELECT.from(Passports)
            .columns('ID', 'passportId', 'model', 'manufacturerId', 'batteryCategory', 'status',
                'manufactureDate', 'weightKg', 'performanceClass', 'qrCodeUrl',
                'payloadHash', 'contractAddress', 'anchorNetwork', 'attestationTxHash', 'createdAt', 'attesterId')
            .orderBy('createdAt desc');
        // Successfully proven ZK claims per passport. Public by design: claim,
        // threshold (scaled back to raw units) and proof tx; never the value.
        const proofs: any[] = await SELECT.from(PredicateProofLog)
            .columns('passport_ID', 'sourceField', 'predicate', 'threshold', 'unit', 'txHash', 'createdAt', 'setRoot', 'setId')
            .where({ status: 'succeeded', result: true })
            .orderBy('createdAt');
        const claimsByPassport = new Map<string, unknown[]>();
        for (const p of proofs) {
            const list = claimsByPassport.get(p.passport_ID) ?? [];
            if (p.predicate === 'setMembership') {
                // The allow-list is public by design; publishing the values
                // lets any verifier recompute the set root from the list.
                const set = claimSetById(p.setId ?? '');
                list.push({
                    sourceField: p.sourceField,
                    predicate: 'setMembership',
                    setRoot: p.setRoot ?? '',
                    setId: p.setId ?? '',
                    setLabel: setLabelFor(p.setId),
                    allowedValues: set?.values ?? null,
                    txHash: p.txHash ?? '',
                    provenAt: p.createdAt ?? null,
                });
            } else {
                list.push({
                    sourceField: p.sourceField,
                    predicate: p.predicate,
                    threshold: Number(p.threshold) / 1000,
                    unit: p.unit ?? '',
                    txHash: p.txHash ?? '',
                    provenAt: p.createdAt ?? null,
                });
            }
            claimsByPassport.set(p.passport_ID, list);
        }
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
                attesterId: r.attesterId ? norm(r.attesterId) : null,
                explorerUrl: explorerTxUrl(r.attestationTxHash as string | null, r.anchorNetwork as string | null),
                createdAt: r.createdAt ?? null,
                claims: (claimsByPassport.get(String(r.ID)) ?? []).map((c: any) => ({
                    ...c, explorerUrl: explorerTxUrl(c.txHash, r.anchorNetwork as string | null),
                })),
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

