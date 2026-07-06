/**
 * Mock SAP goods-receipt source (T21).
 *
 * A goods-receipt is the inbound event an ERP emits when a battery batch is
 * booked in: the public Point-1 header plus the shielded Annex XIII payload
 * (cells / recycled content / due-diligence). `generatePassport(batchId)`
 * consumes one and mints the passport.
 *
 * This module is PURE (no `@sap/cds`, no DB, no clock, no randomness): the
 * receipt is a deterministic function of a sequence number, so the demo can
 * emit an unbounded, varied stream of batches while the mapping stays unit-
 * testable and reproducible. The CAP service (srv/mock-sap-service.ts) owns
 * persistence and the emit counter; this owns the shape and the generator.
 */

export type BatteryCategory = 'EV' | 'INDUSTRIAL' | 'LMT';

export interface GoodsReceiptPublic {
    manufacturerId: string;
    batteryCategory: BatteryCategory;
    model: string;
    manufactureDate: string;   // ISO date (YYYY-MM-DD)
    weightKg: number;
    performanceClass: string;  // A..G per Regulation 2023/1542
}

/** Shielded Annex XIII payload (Points 2-4). Hashed + encrypted, never public. */
export interface GoodsReceiptPayload {
    batteries: Array<{
        serialNumber: string;
        cellChemistry: string;
        capacityKwh: number;
        carbonFootprintKgCO2: number;
        supplierName: string;
    }>;
    recycledMaterials: Array<{ material: string; recycledPercentage: number; sourceSupplierName: string }>;
    diligenceDocs: Array<{ docType: string }>;
}

export interface GoodsReceipt {
    batchId: string;
    passportId: string;
    public: GoodsReceiptPublic;
    payload: GoodsReceiptPayload;
}

/** The shape `generatePassport` consumes. */
export type Batch = GoodsReceipt;

// --- deterministic value pools ----------------------------------------------

const MANUFACTURERS = ['DE-CELLCO-001', 'FR-VOLTAIC-002', 'PL-AKUMA-003', 'SE-NORDCELL-004', 'ES-IBERION-005'] as const;
const CATEGORIES: readonly BatteryCategory[] = ['EV', 'INDUSTRIAL', 'LMT'] as const;
const MODELS = ['PowerCell EV-75', 'GridStack IND-250', 'UrbanGlide LMT-2', 'LongHaul EV-110', 'FlowCore IND-400'] as const;
const CHEMISTRIES = ['NMC-811', 'LFP', 'NCA', 'NMC-622', 'LMFP'] as const;
const CELL_SUPPLIERS = ['CathodeWorks GmbH', 'ElectroChem SA', 'AnodeTech BV', 'IonForge Oy', 'CellCraft AB'] as const;
const CO_SUPPLIERS = ['ReCobalt Recyclers SA', 'CobaltLoop AG', 'BlueMetal Recycling BV'] as const;
const LI_SUPPLIERS = ['LiLoop Recycling BV', 'Lithion Materials Oy', 'WhiteGold Recyclers SA'] as const;
const NI_SUPPLIERS = ['NickelBack Materials Oy', 'NiCycle GmbH', 'PentlanditeWorks AB'] as const;

const round = (n: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
};

/**
 * Deterministically generate the `seq`-th goods-receipt. Varies manufacturer,
 * category, chemistry, suppliers, serial, dates and numeric fields by `seq`, so
 * two calls with the same `seq` are byte-identical and different `seq` values
 * give distinct batches. `seq` is a positive integer (the emit counter).
 */
export function generateGoodsReceipt(seq: number): GoodsReceipt {
    if (!Number.isInteger(seq) || seq < 1) throw new Error('seq must be a positive integer');
    const i = seq;
    const pick = <T,>(arr: readonly T[], off = 0): T => arr[(i + off) % arr.length];
    const num = String(i).padStart(4, '0');
    const mm = String(1 + (i % 12)).padStart(2, '0');
    const dd = String(1 + ((i * 7) % 27)).padStart(2, '0');

    return {
        batchId: `BATCH-GR-${num}`,
        passportId: `BAT-GR-${num}`,
        public: {
            manufacturerId: pick(MANUFACTURERS),
            batteryCategory: pick(CATEGORIES),
            model: pick(MODELS, 1),
            manufactureDate: `2026-${mm}-${dd}`,
            weightKg: round(300 + ((i * 13.5) % 200), 3),
            performanceClass: 'ABCDEFG'[i % 7]
        },
        payload: {
            batteries: [{
                serialNumber: `SN-AX-${1000 + i}`,
                cellChemistry: pick(CHEMISTRIES),
                capacityKwh: round(40 + ((i * 7.5) % 80), 1),
                carbonFootprintKgCO2: round(2500 + ((i * 137.25) % 2000), 2),
                supplierName: pick(CELL_SUPPLIERS, 2)
            }],
            recycledMaterials: [
                { material: 'Co', recycledPercentage: round(10 + ((i * 3.3) % 20), 2), sourceSupplierName: pick(CO_SUPPLIERS) },
                { material: 'Li', recycledPercentage: round(5 + ((i * 2.1) % 15), 2), sourceSupplierName: pick(LI_SUPPLIERS) },
                { material: 'Ni', recycledPercentage: round(8 + ((i * 4.4) % 18), 2), sourceSupplierName: pick(NI_SUPPLIERS) }
            ],
            diligenceDocs: [{ docType: 'supply-chain-due-diligence-report' }]
        }
    };
}

// --- DB row <-> batch mapping ------------------------------------------------

export interface GoodsReceiptRow {
    batchId: string;
    passportId: string;
    manufacturerId: string;
    batteryCategory: string;
    model: string;
    manufactureDate: string;
    weightKg: number;
    performanceClass: string;
    payloadJson: string;   // JSON of GoodsReceiptPayload
    status?: string;       // 'new' | 'consumed'
}

/** Flatten a goods-receipt to a persistable row (payload serialized as JSON). */
export function goodsReceiptToRow(gr: GoodsReceipt, status = 'new'): GoodsReceiptRow {
    return {
        batchId: gr.batchId,
        passportId: gr.passportId,
        manufacturerId: gr.public.manufacturerId,
        batteryCategory: gr.public.batteryCategory,
        model: gr.public.model,
        manufactureDate: gr.public.manufactureDate,
        weightKg: gr.public.weightKg,
        performanceClass: gr.public.performanceClass,
        payloadJson: JSON.stringify(gr.payload),
        status
    };
}

/** Reconstruct a batch from a persisted row (parses the shielded payload). */
export function rowToBatch(row: GoodsReceiptRow): GoodsReceipt {
    let payload: GoodsReceiptPayload;
    try {
        payload = JSON.parse(row.payloadJson);
    } catch {
        throw new Error(`goods-receipt '${row.batchId}' has invalid payloadJson`);
    }
    return {
        batchId: row.batchId,
        passportId: row.passportId,
        public: {
            manufacturerId: row.manufacturerId,
            batteryCategory: row.batteryCategory as BatteryCategory,
            model: row.model,
            manufactureDate: String(row.manufactureDate),
            weightKg: Number(row.weightKg),
            performanceClass: row.performanceClass
        },
        payload
    };
}

/**
 * The canonical demo receipt. Kept byte-stable (same payload as the original
 * hard-coded seam) so `BAT-PREVIEW-0001` keeps the same payloadHash and its
 * on-chain anchor / QR remain valid across the rework.
 */
export const PREVIEW_RECEIPT: GoodsReceipt = {
    batchId: 'BATCH-PREVIEW-0001',
    passportId: 'BAT-PREVIEW-0001',
    public: {
        manufacturerId: 'DE-CELLCO-001',
        batteryCategory: 'EV',
        model: 'PowerCell EV-75',
        manufactureDate: '2026-03-15',
        weightKg: 432.5,
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
