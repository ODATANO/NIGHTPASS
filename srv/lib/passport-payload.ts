/**
 * Canonical payload projection v2. The pure projection (payloadFromDb) is
 * extracted to @odatano/dpp-sdk (shared with DAYPASS, byte-identical hashing);
 * only the thin CAP reader lives here. See the SDK module for the determinism
 * rules and the v1/v2 drift story.
 */

import cds from '@sap/cds';
import type { GuideAttributeRow } from '@odatano/dpp-sdk/battery/guide-defaults';

export { PAYLOAD_VERSION, payloadFromDb, type PayloadInputs } from '@odatano/dpp-sdk/payload';
import type { PayloadInputs } from '@odatano/dpp-sdk/payload';

const { SELECT } = cds.ql;

/** Read the payload inputs of a passport from the DB (current state). */
export async function readPayloadInputs(passportRowId: string): Promise<PayloadInputs> {
    const [batteries, recycledMaterials, diligenceDocs, attributes] = await Promise.all([
        cds.run(SELECT.from('passport.Batteries')
            .columns('serialNumber', 'cellChemistry', 'capacityKwh', 'carbonFootprintKgCO2', 'supplierName',
                'recycledContentPct', 'cycleLife', 'roundTripEfficiencyPct', 'leadContentPpm')
            .where({ passport_ID: passportRowId })),
        cds.run(SELECT.from('passport.RecycledMaterials')
            .columns('material', 'recycledPercentage', 'sourceSupplierName')
            .where({ passport_ID: passportRowId })),
        cds.run(SELECT.from('passport.DiligenceDoc')
            .columns('docType', 'fileName', 'sha256')
            .where({ passport_ID: passportRowId })),
        cds.run(SELECT.from('passport.PassportAttributes')
            .columns('section', 'attribute', 'valueJson', 'accessClass')
            .where({ passport_ID: passportRowId })),
    ]) as [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], GuideAttributeRow[]];
    return {
        batteries: batteries ?? [],
        recycledMaterials: recycledMaterials ?? [],
        diligenceDocs: diligenceDocs ?? [],
        attributes: attributes ?? [],
    };
}
