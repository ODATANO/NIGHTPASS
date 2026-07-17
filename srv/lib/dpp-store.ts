/**
 * In-memory versioned DPP store + pure helpers for the BatteryPass-Ready
 * DPP Life Cycle API v1.1 conformance adapter (spec published by
 * batterypass-ready.gefeg.com). The official test executor seeds state via
 * the TestAdapter (TestSetup/TestTeardown) before every scenario, so the store
 * is deliberately process-local and never touches the passport database.
 */

export type DppStatus = 'draft' | 'active' | 'archived' | 'deleted';

export interface DppVersion {
    dppId: string;
    productId: string;
    version: number;
    status: DppStatus;
    document: unknown;
    validFrom: string; // ISO timestamp when this version became current
}

/** Role names the TestAdapter can issue credentials for. */
export type DppRole = 'public' | 'legitimate_interest' | 'authority' | 'commission';

type AccessClass = 'public' | 'legitimateInterest' | 'authority';

/**
 * Guide attribute name → longlist access class (Battery Passport Data
 * Attribute Longlist v1.2, DIN DKE SPEC 99100). Anything not listed is
 * treated as public; sub-structure of a listed attribute is filtered as a
 * whole. Kept in sync with the classes seeded by
 * scripts/bp-ready-seed-attributes.mjs.
 */
export const GUIDE_ACCESS: Record<string, AccessClass> = {
    // Identifiers and product data. The raw operator/manufacturer/facility
    // identifiers (EORI/GLN) are restricted in the BatteryPass-Ready access
    // model even though the surrounding info blocks are public; confirmed by
    // the executor's accessRightsValidationReport (2026-07-17).
    DateOfPuttingTheBatteryIntoService: 'legitimateInterest',
    BatteryStatus: 'legitimateInterest',
    UniqueEconomicOperatorIdentifier: 'legitimateInterest',
    UniqueManufacturerIdentifier: 'legitimateInterest',
    UniqueFacilityIdentifier: 'legitimateInterest',
    // Performance and durability (dynamic/telemetry attributes are LI)
    RemainingCapacity: 'legitimateInterest',
    CapacityFade: 'legitimateInterest',
    RemainingUsableBatteryEnergy: 'legitimateInterest',
    StateOfCertifiedEnergySOCE: 'legitimateInterest',
    StateOfChargeSoC: 'legitimateInterest',
    RemainingPowerCapability: 'legitimateInterest',
    PowerFade: 'legitimateInterest',
    EnergyRoundTripEfficiencyFade: 'legitimateInterest',
    RemainingRoundTripEnergyEfficiency: 'legitimateInterest',
    InitialSelfDischargeRate: 'legitimateInterest',
    CurrentSelfDischargeRate: 'legitimateInterest',
    EvolutionOfSelfDischargeRates: 'legitimateInterest',
    InternalResistanceIncreaseOfPackCellAndModuleRecommended: 'legitimateInterest',
    ExpectedLifetimeInCalendarYears: 'legitimateInterest',
    NumberOfFullChargingAndDischargingCycles: 'legitimateInterest',
    EnergyThroughput: 'legitimateInterest',
    CapacityThroughput: 'legitimateInterest',
    TemperatureInformation: 'legitimateInterest',
    TimeSpentInExtremeTemperaturesAboveBoundary: 'legitimateInterest',
    TimeSpentInExtremeTemperaturesBelowBoundary: 'legitimateInterest',
    TimeSpentChargingDuringExtremeTemperaturesAboveBoundary: 'legitimateInterest',
    TimeSpentChargingDuringExtremeTemperaturesBelowBoundary: 'legitimateInterest',
    NumberOfDeepDischargeEvents: 'legitimateInterest',
    NumberOfOverchargeEvents: 'legitimateInterest',
    InformationOnAccidents: 'legitimateInterest',
    // Materials and composition
    MaterialsUsedInCathodeAnodeAndElectrolyte: 'legitimateInterest',
    // Circularity (LI + Commission class in the longlist)
    'DismantlingInformation-ManualsForTheRemovalAndTheDisassemblyOfTheBatteryPack': 'legitimateInterest',
    PartNumbersForComponents: 'legitimateInterest',
    InformationOnSourcesOfSpareParts: 'legitimateInterest',
    SafetyMeasures: 'legitimateInterest',
    // Symbols, labels and documentation of conformity
    ResultsOfTestReportsProvingCompliance: 'authority',
};

/** Whether a role may read attributes of the given access class. */
export function roleSees(role: DppRole, cls: AccessClass): boolean {
    if (cls === 'authority') return role === 'authority' || role === 'commission';
    if (cls === 'legitimateInterest') return role !== 'public';
    return true;
}

/**
 * Deep-filter a DPP document for a role: every object member whose key is a
 * classified guide attribute above the role's reach is removed (with its whole
 * substructure). The operator (no token) never goes through this.
 */
export function filterDocumentForRole(doc: unknown, role: DppRole): unknown {
    if (Array.isArray(doc)) return doc.map((d) => filterDocumentForRole(d, role));
    if (!doc || typeof doc !== 'object') return doc;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
        const cls = GUIDE_ACCESS[k];
        if (cls && !roleSees(role, cls)) continue;
        out[k] = filterDocumentForRole(v, role);
    }
    return out;
}

/** RFC 7396 JSON merge patch (null deletes, objects merge, rest replaces). */
export function mergePatch(target: unknown, patch: unknown): unknown {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
    const base: Record<string, unknown> =
        target && typeof target === 'object' && !Array.isArray(target)
            ? { ...(target as Record<string, unknown>) }
            : {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (v === null) delete base[k];
        else base[k] = mergePatch(base[k], v);
    }
    return base;
}

/**
 * Resolve an element path inside a DPP document. Accepts '/', '.' or ':'
 * separated segments; a leading 'Battery_Passport' wrapper segment is optional
 * both in the path and in the document.
 */
export function splitElementPath(elementPath: string): string[] {
    const decoded = decodeURIComponent(elementPath);
    // The executor sends JSONPath-flavored paths ('$.*.Section.Attribute'):
    // '$' is the root and '*' the top-level wrapper, both are positional noise.
    const parts = decoded.split(/[/.:]/).map((s) => s.trim()).filter((s) => s && s !== '$' && s !== '*');
    return parts;
}

function unwrap(doc: unknown): unknown {
    if (doc && typeof doc === 'object' && 'Battery_Passport' in (doc as Record<string, unknown>)) {
        return (doc as Record<string, unknown>).Battery_Passport;
    }
    return doc;
}

export function getElement(doc: unknown, parts: string[]): unknown {
    let segs = parts;
    if (segs[0] === 'Battery_Passport') segs = segs.slice(1);
    let node = unwrap(doc);
    for (const seg of segs) {
        if (!node || typeof node !== 'object') return undefined;
        node = (node as Record<string, unknown>)[seg];
    }
    return node;
}

/** Set (merge-patch) an element at path; returns a new document. */
export function patchElement(doc: unknown, parts: string[], patch: unknown): unknown {
    let segs = parts;
    if (segs[0] === 'Battery_Passport') segs = segs.slice(1);
    const root = JSON.parse(JSON.stringify(doc ?? {}));
    const hasWrapper = root && typeof root === 'object' && 'Battery_Passport' in root;
    let node: Record<string, unknown> = hasWrapper ? root.Battery_Passport : root;
    for (const seg of segs.slice(0, -1)) {
        if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
        node = node[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1];
    const merged = mergePatch(node[leaf], patch);
    if (merged === null) delete node[leaf];
    else node[leaf] = merged;
    return root;
}

function identifiersOf(doc: unknown): Record<string, unknown> | undefined {
    const bp = unwrap(doc);
    return (bp as Record<string, unknown> | undefined)?.IdentifiersAndProductData as
        | Record<string, unknown>
        | undefined;
}

/** Extract a product id from a guide document when the command omits it. */
export function productIdOf(doc: unknown): string | undefined {
    const v = identifiersOf(doc)?.UniqueBatteryIdentifierUniqueProductIdentifier;
    return typeof v === 'string' ? v : undefined;
}

/** Extract the DPP id declared inside a guide document. */
export function dppIdOf(doc: unknown): string | undefined {
    const v = identifiersOf(doc)?.UniqueBatteryPassportIdentifierUniqueDPPIdentifier;
    return typeof v === 'string' ? v : undefined;
}

/** Extract the operator id (needed for the EU Registry registration). */
export function operatorIdOf(doc: unknown): string | undefined {
    const v = identifiersOf(doc)?.UniqueEconomicOperatorIdentifier;
    return typeof v === 'string' ? v : undefined;
}

/** Status declared inside a guide document (DPPStatus.dppStatusValue). */
export function statusOf(doc: unknown): DppStatus | undefined {
    const s = identifiersOf(doc)?.DPPStatus as Record<string, unknown> | undefined;
    const v = String(s?.dppStatusValue ?? '').toLowerCase();
    return v === 'draft' || v === 'active' || v === 'archived' || v === 'deleted' ? (v as DppStatus) : undefined;
}

/**
 * Stamp the regulation-required last-update timestamp on a (new version of a)
 * document. Returns a deep copy; the input stays untouched.
 */
export function touchLastUpdate(doc: unknown, at?: string): unknown {
    const copy = JSON.parse(JSON.stringify(doc ?? {}));
    const bp = copy && typeof copy === 'object' && 'Battery_Passport' in copy ? copy.Battery_Passport : copy;
    if (bp && typeof bp === 'object') {
        const ids = (bp.IdentifiersAndProductData ??= {});
        ids['Date-timeOfLatestUpdateOfDPP'] = (at ?? new Date().toISOString()).replace(/\.\d{3}Z$/, 'Z');
    }
    return copy;
}

/** Versioned store keyed by dppId with a productId index. */
export class DppStore {
    private byDpp = new Map<string, DppVersion[]>();

    clear(): void {
        this.byDpp.clear();
    }

    /** Rehydrate one persisted version row (ordered by version per dppId). */
    loadVersion(row: DppVersion): void {
        const list = this.byDpp.get(row.dppId) ?? [];
        list.push(row);
        list.sort((a, b) => a.version - b.version);
        this.byDpp.set(row.dppId, list);
    }

    /**
     * Insert a fresh DPP (TestSetup insertBatteryPass or POST /dpps). Every
     * insert starts its own chain: an explicit dppId replaces a chain of the
     * same id (TestSetup re-seeding), a document-derived id that collides gets
     * a suffix so two seeded passes never merge into one version history.
     * Status defaults to what the document itself declares (an "archived"
     * example document seeds an archived DPP).
     */
    insert(opts: { dppId?: string; productId?: string; status?: string; document: unknown; at?: string }): DppVersion {
        const document = opts.document;
        let dppId = opts.dppId;
        if (!dppId) {
            const declared = dppIdOf(document) || `urn:odatano:dpp:${cryptoRandom()}`;
            dppId = this.byDpp.has(declared) ? `${declared}#${cryptoRandom().slice(0, 8)}` : declared;
        }
        const productId = opts.productId || productIdOf(document) || dppId;
        const status = normalizeStatus(opts.status) ?? statusOf(document) ?? 'active';
        const row: DppVersion = {
            dppId,
            productId,
            version: 1,
            status,
            document,
            validFrom: opts.at ?? new Date().toISOString(),
        };
        this.byDpp.set(dppId, [row]);
        return row;
    }

    /** Latest version row for a dppId regardless of status. */
    latest(dppId: string): DppVersion | undefined {
        const list = this.byDpp.get(dppId);
        return list?.[list.length - 1];
    }

    /** Readable current version (404 when archived/deleted or absent). */
    current(dppId: string): DppVersion | undefined {
        const row = this.latest(dppId);
        if (!row || row.status === 'archived' || row.status === 'deleted') return undefined;
        return row;
    }

    /** Supersede the current version with an updated document (new active version). */
    update(dppId: string, document: unknown, at?: string): DppVersion | undefined {
        const list = this.byDpp.get(dppId);
        const head = list?.[list.length - 1];
        if (!head || head.status === 'archived' || head.status === 'deleted') return undefined;
        const row: DppVersion = {
            dppId,
            productId: head.productId,
            version: head.version + 1,
            status: 'active',
            document,
            validFrom: at ?? new Date().toISOString(),
        };
        list!.push(row);
        return row;
    }

    /** Soft-delete (kept for audit, never served again via normal reads). */
    delete(dppId: string): DppVersion | undefined {
        const list = this.byDpp.get(dppId);
        const head = list?.[list.length - 1];
        if (!head || head.status === 'deleted') return undefined;
        const row: DppVersion = { ...head, version: head.version + 1, status: 'deleted', validFrom: new Date().toISOString() };
        list!.push(row);
        return row;
    }

    /** Mark the whole DPP active (TestSetup bringBatteryToMarket). */
    activateByProduct(productId: string): DppVersion | undefined {
        for (const list of this.byDpp.values()) {
            const head = list[list.length - 1];
            if (head.productId === productId && head.status !== 'deleted') {
                if (head.status === 'active') return head;
                const row: DppVersion = { ...head, version: head.version + 1, status: 'active', validFrom: new Date().toISOString() };
                list.push(row);
                return row;
            }
        }
        return undefined;
    }

    /** Current active DPP (latest version) for a product id. */
    activeByProduct(productId: string): DppVersion | undefined {
        for (const list of this.byDpp.values()) {
            const head = list[list.length - 1];
            if (head.productId === productId && head.status === 'active') return head;
        }
        return undefined;
    }

    /** The version that was current for a product id at a given date. */
    byProductAndDate(productId: string, date: string): DppVersion | undefined {
        const t = Date.parse(date);
        if (Number.isNaN(t)) return undefined;
        let best: DppVersion | undefined;
        for (const list of this.byDpp.values()) {
            for (const row of list) {
                if (row.productId !== productId || row.status === 'deleted') continue;
                const from = Date.parse(row.validFrom);
                if (from <= t && (!best || from >= Date.parse(best.validFrom))) best = row;
            }
        }
        return best;
    }
}

function normalizeStatus(s?: string): DppStatus | undefined {
    const v = String(s ?? '').toLowerCase();
    return v === 'draft' || v === 'active' || v === 'archived' || v === 'deleted' ? (v as DppStatus) : undefined;
}

function cryptoRandom(): string {
    return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
