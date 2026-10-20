/**
 * The app's membership catalog: every product family's allow-lists, looked
 * up by id. The connector bundle and the demo import through this module.
 */
import {
    claimSetById as sdkClaimSetById, claimSetsForField as sdkClaimSetsForField,
    setLabelFor as sdkSetLabelFor, type ClaimSet,
} from '@odatano/dpp-sdk/claim-sets';
import { ALL_CLAIM_SETS } from './product-profiles';

export { MAX_SET_VALUES, SET_MERKLE_DEPTH, type ClaimSet } from '@odatano/dpp-sdk/claim-sets';
export { CHEMISTRY_CODES } from '@odatano/dpp-sdk/battery/claim-sets';

export const CLAIM_SETS: readonly ClaimSet[] = ALL_CLAIM_SETS;

export function claimSetById(id: string): ClaimSet | undefined {
    return sdkClaimSetById(CLAIM_SETS, id);
}

export function claimSetsForField(sourceField: string): ClaimSet[] {
    return sdkClaimSetsForField(CLAIM_SETS, sourceField);
}

export function setLabelFor(setId: string | null | undefined): string {
    return sdkSetLabelFor(CLAIM_SETS, setId);
}
