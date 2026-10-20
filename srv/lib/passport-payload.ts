/**
 * Canonical payload of a passport: the profile's children plus the attribute
 * rows, read from the database and projected by the dpp-sdk engine. The
 * projection is the frozen hash contract; only the CAP reader lives here.
 */
import cds from '@sap/cds';
import { projectPayload, type ProfileRows } from '@odatano/dpp-sdk/profile';
import type { AttributeRow } from '@odatano/dpp-sdk/attributes';
import type { AppProfile } from './product-profiles';

export { projectPayload, type ProfileRows };

const { SELECT } = cds.ql;

/** Child rows of every profile child plus the attribute rows (current state). */
export async function readProfileRows(app: AppProfile, passportRowId: string): Promise<ProfileRows> {
    const rows: ProfileRows = {};
    await Promise.all(Object.entries(app.profile.children).map(async ([key, spec]) => {
        const entity = app.childEntities[key];
        if (!entity) throw new Error(`profile '${app.id}' has no table for child '${key}'`);
        const list = await cds.run(SELECT.from(entity)
            .columns(...Object.keys(spec.columns))
            .where({ passport_ID: passportRowId })) as Record<string, unknown>[] | undefined;
        rows[key] = list ?? [];
    }));
    const attributes = await cds.run(SELECT.from('passport.PassportAttributes')
        .columns('section', 'attribute', 'valueJson', 'accessClass')
        .where({ passport_ID: passportRowId })) as AttributeRow[] | undefined;
    rows.attributes = attributes ?? [];
    return rows;
}

/** The canonical payload of a passport as stored right now. */
export async function readPayload(app: AppProfile, passportRowId: string): Promise<Record<string, unknown>> {
    return projectPayload(app.profile, await readProfileRows(app, passportRowId));
}
