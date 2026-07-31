/**
 * S/4HANA material-document mapping (Sprint 2 "real SAP lane").
 *
 * A goods receipt posted in S/4 surfaces as a Material Document
 * (API_MATERIAL_DOCUMENT_SRV, OData V2): one header, N items, movement type
 * '101' for a goods receipt against a purchase or production order. This
 * module turns such a document into the flat PassportInput that
 * `createPassport` consumes, wrapped in the same CloudEvent contract the
 * EQUINOX emitter uses against POST /api/v1/passport/erp-events.
 *
 * The ERP document carries logistics facts only (material, plant, batch,
 * quantity, dates). The Annex XIII product data (cell chemistry, capacity,
 * carbon footprint, recycled shares, due-diligence refs) lives outside the
 * material document in real landscapes (PLM, supplier declarations, custom
 * Z-fields). That side is supplied here as a product-master lookup keyed by
 * Material number; see config/s4-product-master.example.json and
 * docs/s4-mapping.md for the field-by-field mapping rationale.
 *
 * This module is PURE (no fetch, no clock, no randomness): the bridge script
 * (scripts/s4-bridge.mts) owns HTTP, polling state and event ids.
 */

import crypto from 'node:crypto';

// --- S/4 OData V2 shapes (the subset the mapping reads) ----------------------

export interface S4MaterialDocumentItem {
    MaterialDocumentYear: string;
    MaterialDocument: string;
    MaterialDocumentItem: string;
    Material: string;
    Plant?: string;
    Batch?: string;
    Supplier?: string;
    GoodsMovementType: string;            // '101' = goods receipt
    QuantityInEntryUnit?: string | number;
    EntryUnit?: string;
    ManufactureDate?: string | null;      // V2 '/Date(ms)/' or ISO
    GoodsMovementIsCancelled?: boolean;
}

export interface S4MaterialDocumentHeader {
    MaterialDocumentYear: string;
    MaterialDocument: string;
    PostingDate?: string | null;          // V2 '/Date(ms)/' or ISO
    DocumentDate?: string | null;
    to_MaterialDocumentItem?: { results: S4MaterialDocumentItem[] } | S4MaterialDocumentItem[];
}

// --- Product master (the non-ERP Annex XIII side) ----------------------------

export interface ProductMasterEntry {
    manufacturerId: string;
    batteryCategory: string;              // EV | INDUSTRIAL | LMT | STATIONARY | INDUSTRIAL_NO_BMS
    /** Optional when S/4 product enrichment supplies the description instead. */
    model?: string;
    performanceClass: string;             // A..G
    /** Optional when S/4 product enrichment supplies the net weight instead. */
    weightKg?: number;
    battery: {
        cellChemistry: string;
        capacityKwh: number;
        carbonFootprintKgCO2: number;
        supplierName: string;
    };
    recycledMaterials: Array<{ material: string; recycledPercentage: number; sourceSupplierName: string }>;
    diligenceDocs?: Array<{ docType: string }>;
}

/** Keyed by S/4 Material number, exactly as it appears on the document item. */
export type ProductMaster = Record<string, ProductMasterEntry>;

// --- Output shapes -----------------------------------------------------------

/** The flat shape `createPassport(passportJson)` consumes (see erp-ingest e2e). */
export interface PassportInput {
    passportId: string;
    manufacturerId: string;
    batteryCategory: string;
    model: string;
    manufactureDate: string;              // YYYY-MM-DD
    weightKg: number;
    performanceClass: string;
    batteries: Array<ProductMasterEntry['battery'] & { serialNumber: string }>;
    recycledMaterials: ProductMasterEntry['recycledMaterials'];
    diligenceDocs: Array<{ docType: string }>;
}

/** Wire contract of POST /api/v1/passport/erp-events (server.ts checks `type`). */
export const ERP_EVENT_TYPE = 'com.odatano.equinox.goodsreceipt.created';

export interface ErpCloudEvent {
    specversion: '1.0';
    id: string;
    source: string;
    type: typeof ERP_EVENT_TYPE;
    time: string;
    data: PassportInput;
}

// --- Helpers -----------------------------------------------------------------

/**
 * Parse an OData V2 date ('/Date(1721088000000)/', legacy edm wrapper) or a
 * plain ISO string into 'YYYY-MM-DD'. Returns null for absent/invalid input.
 */
export function parseS4Date(value: string | null | undefined): string | null {
    if (!value) return null;
    const m = /\/Date\((-?\d+)(?:[+-]\d+)?\)\//.exec(value);
    const d = m ? new Date(Number(m[1])) : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

/** Normalize the V2 `{ results: [...] }` envelope (V4 arrays pass through). */
export function itemsOf(header: S4MaterialDocumentHeader): S4MaterialDocumentItem[] {
    const nav = header.to_MaterialDocumentItem;
    if (!nav) return [];
    return Array.isArray(nav) ? nav : (nav.results ?? []);
}

export interface GoodsReceiptDocItem {
    header: S4MaterialDocumentHeader;
    item: S4MaterialDocumentItem;
}

/**
 * Flatten headers to (header, item) pairs, keeping only the requested goods
 * movement types (default '101') and dropping cancelled items.
 */
export function goodsReceiptItems(
    headers: S4MaterialDocumentHeader[],
    movementTypes: readonly string[] = ['101']
): GoodsReceiptDocItem[] {
    const wanted = new Set(movementTypes);
    const out: GoodsReceiptDocItem[] = [];
    for (const header of headers) {
        for (const item of itemsOf(header)) {
            if (!wanted.has(item.GoodsMovementType)) continue;
            if (item.GoodsMovementIsCancelled) continue;
            out.push({ header, item });
        }
    }
    return out;
}

const sanitizeId = (s: string): string =>
    s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 18);

/**
 * Deterministic passport id for a document item. Material documents are
 * unique per (year, number, item), so re-polling the same document maps to
 * the same id and the webhook's idempotency turns it into a no-op.
 * Kept short: the EU registry caps the UPI URL at 50 chars.
 */
export function passportIdFor(item: S4MaterialDocumentItem): string {
    return `BAT-${sanitizeId(item.Material)}-${sanitizeId(item.MaterialDocument)}${sanitizeId(item.MaterialDocumentItem)}`;
}

/** Stable per-document-item key for the bridge's seen-state. */
export function docItemKey(item: S4MaterialDocumentItem): string {
    return `${item.MaterialDocumentYear}/${item.MaterialDocument}/${item.MaterialDocumentItem}`;
}

// --- S/4 product-master enrichment (API_PRODUCT_SRV) -------------------------

/** The subset of A_Product / A_ProductDescription the enrichment reads. */
export interface S4ProductData {
    NetWeight?: string | number | null;
    GrossWeight?: string | number | null;
    WeightUnit?: string | null;
    description?: string | null;          // A_ProductDescription.ProductDescription
}

const parseWeightKg = (value: string | number | null | undefined, unit: string | null | undefined): number | null => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = String(unit ?? '').toUpperCase();
    if (u === 'KG' || u === 'KGM') return n;
    if (u === 'G' || u === 'GRM') return n / 1000;
    return null;
};

/**
 * Overlay real S/4 product-master data on a configured entry. The live system
 * wins where it has an answer: net weight (gross as fallback) replaces the
 * configured weightKg; the product description fills a missing model. The
 * configured values remain the fallback, so a failed lookup degrades cleanly.
 */
export function applyProductData(entry: ProductMasterEntry, product?: S4ProductData | null): ProductMasterEntry {
    if (!product) return entry;
    const weight = parseWeightKg(product.NetWeight, product.WeightUnit)
        ?? parseWeightKg(product.GrossWeight, product.WeightUnit);
    return {
        ...entry,
        weightKg: weight ?? entry.weightKg,
        model: entry.model ?? (product.description || undefined)
    };
}

// --- Mapping -----------------------------------------------------------------

/**
 * Map one goods-receipt document item to the flat PassportInput. Throws when
 * the material has no product-master entry (the bridge logs and skips those:
 * not every received material is a battery).
 */
export function materialDocumentToPassportInput(
    { header, item }: GoodsReceiptDocItem,
    master: ProductMaster
): PassportInput {
    const entry = master[item.Material];
    if (!entry) throw new Error(`no product-master entry for material '${item.Material}'`);
    if (entry.model == null || entry.weightKg == null) {
        throw new Error(`product-master entry '${item.Material}' is missing model/weightKg (set them or enable S/4 product enrichment)`);
    }

    const manufactureDate =
        parseS4Date(item.ManufactureDate) ??
        parseS4Date(header.PostingDate) ??
        parseS4Date(header.DocumentDate);
    if (!manufactureDate) {
        throw new Error(`document ${docItemKey(item)} has no usable manufacture/posting date`);
    }

    const serialNumber = item.Batch
        ? `SN-${sanitizeId(item.Batch)}`
        : `SN-${sanitizeId(item.MaterialDocument)}-${sanitizeId(item.MaterialDocumentItem)}`;

    return {
        passportId: passportIdFor(item),
        manufacturerId: entry.manufacturerId,
        batteryCategory: entry.batteryCategory,
        model: entry.model,
        manufactureDate,
        weightKg: entry.weightKg,
        performanceClass: entry.performanceClass,
        batteries: [{ serialNumber, ...entry.battery }],
        recycledMaterials: entry.recycledMaterials,
        diligenceDocs: entry.diligenceDocs ?? [{ docType: 'supply-chain-due-diligence-report' }]
    };
}

/** Wrap a PassportInput in the webhook's CloudEvent envelope. */
export function toCloudEvent(
    data: PassportInput,
    opts: { source: string; id: string; time: string }
): ErpCloudEvent {
    return {
        specversion: '1.0',
        id: opts.id,
        source: opts.source,
        type: ERP_EVENT_TYPE,
        time: opts.time,
        data
    };
}

/** HMAC signature the webhook expects in the x-equinox-signature header. */
export function signErpEventBody(rawBody: Buffer | string, secret: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}
