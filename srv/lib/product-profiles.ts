/**
 * The product families this app issues passports for. Each entry binds a
 * dpp-sdk profile to the tables that hold its children and to its membership
 * catalog. `Passports.profile` names the family of a row.
 */
import type { ProductProfile } from '@odatano/dpp-sdk/profile';
import type { ClaimSet } from '@odatano/dpp-sdk/claim-sets';
import { validateClaimSets } from '@odatano/dpp-sdk/claim-sets';
import { BATTERY_PROFILE } from '@odatano/dpp-sdk/battery/profile';
import { BATTERY_CLAIM_SETS } from '@odatano/dpp-sdk/battery/claim-sets';
import { COMPONENT_PROFILE } from '@odatano/dpp-sdk/component/profile';
import { COMPONENT_CLAIM_SETS } from '@odatano/dpp-sdk/component/claim-sets';

export type ProfileId = 'battery' | 'component';

export interface AppProfile {
    id: ProfileId;
    profile: ProductProfile;
    /** Display name of the family, singular. */
    label: string;
    /** Regulation or standard the passport serves, one line. */
    regulation: string;
    /** Payload child key -> db entity holding its rows. */
    childEntities: Readonly<Record<string, string>>;
    claimSets: readonly ClaimSet[];
    /** Public attribute names the explorer shows next to the head fields. */
    explorerAttributes: readonly string[];
}

export const APP_PROFILES: Readonly<Record<ProfileId, AppProfile>> = {
    battery: {
        id: 'battery',
        profile: BATTERY_PROFILE,
        label: 'Battery passport',
        regulation: 'EU Battery Regulation 2023/1542, Annex XIII',
        childEntities: {
            batteries: 'passport.Batteries',
            recycledMaterials: 'passport.RecycledMaterials',
            diligenceDocs: 'passport.DiligenceDoc',
        },
        claimSets: BATTERY_CLAIM_SETS,
        explorerAttributes: [],
    },
    component: {
        id: 'component',
        profile: COMPONENT_PROFILE,
        label: 'Component passport',
        regulation: 'Safety-related plant components (ASME III / KTA 1401 quality assurance)',
        childEntities: {
            materialCertificates: 'passport.MaterialCertificates',
            qualificationTests: 'passport.QualificationTests',
            custodyRecords: 'passport.CustodyRecords',
        },
        claimSets: COMPONENT_CLAIM_SETS,
        explorerAttributes: ['SafetyClass', 'ComponentStatus'],
    },
};

export const PROFILE_IDS = Object.keys(APP_PROFILES) as ProfileId[];

export function isProfileId(v: unknown): v is ProfileId {
    return typeof v === 'string' && v in APP_PROFILES;
}

/** The family of a row; rows from before the column existed are batteries. */
export function appProfileOf(id: unknown): AppProfile {
    if (id == null || id === '') return APP_PROFILES.battery;
    if (!isProfileId(id)) throw new Error(`unknown product profile '${String(id)}'`);
    return APP_PROFILES[id];
}

/** Every membership set of every family; ids are unique across families. */
export const ALL_CLAIM_SETS: readonly ClaimSet[] = PROFILE_IDS.flatMap((id) => [...APP_PROFILES[id].claimSets]);
validateClaimSets(ALL_CLAIM_SETS);
