/** The state reads of the NIGHTGATE API's public verify service. They need no token. */
import { apiUrlFromEnv, hostedVerifyClient } from './lane-remote';

export type VerifyRead = 'verifyAttestationState' | 'verifyPredicateState' | 'verifyDisclosureState';

/** Runs one state read. Throws on transport errors; a negative answer is a normal `{ verified: false }`. */
export async function readState(read: VerifyRead, params: Record<string, unknown>): Promise<any> {
    const ng = await hostedVerifyClient({ apiUrl: apiUrlFromEnv() });
    return ng.callFunction(read, params as any);
}
