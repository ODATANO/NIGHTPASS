/** S/4HANA material-document mapper plus the battery product master it maps from. */
import type { MappingOptions, ProductMaster } from '@odatano/dpp-sdk/integrations/s4';

export * from '@odatano/dpp-sdk/integrations/s4';

/** Wire contract of POST /api/v1/passport/erp-events (server.ts checks `type`). */
export const ERP_EVENT_TYPE = 'com.odatano.equinox.goodsreceipt.created';

/** Battery passports: `BAT-` ids, the serial goes on the first battery row. */
export const BATTERY_MAPPING: MappingOptions = { idPrefix: 'BAT', serial: { child: 'batteries', column: 'serialNumber' } };

/** One material in config/s4-product-master.json: the battery facts the ERP document does not carry. */
export interface BatteryMasterEntry {
    manufacturerId: string;
    batteryCategory: string;
    model?: string;              // optional; S/4 product enrichment may supply the description
    performanceClass: string;
    weightKg?: number;           // optional; S/4 product enrichment may supply the net weight
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
export type BatteryMaster = Record<string, BatteryMasterEntry>;

/** Product master in the mapper's shape: head fields and child collections copied onto the passport input. */
export function batteryProductMaster(configured: BatteryMaster): ProductMaster {
    const out: ProductMaster = {};
    for (const [material, e] of Object.entries(configured)) {
        out[material] = {
            model: e.model,
            weightKg: e.weightKg,
            head: { manufacturerId: e.manufacturerId, batteryCategory: e.batteryCategory, performanceClass: e.performanceClass },
            children: {
                batteries: [{ ...e.battery }],
                recycledMaterials: e.recycledMaterials.map((r) => ({ ...r })),
                diligenceDocs: e.diligenceDocs ?? [{ docType: 'supply-chain-due-diligence-report' }],
            },
        };
    }
    return out;
}
