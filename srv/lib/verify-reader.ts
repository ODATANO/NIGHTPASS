/**
 * One seam for the crawler-free state reads (`verifyAttestationState`,
 * `verifyPredicateState`). Plugin: the in-process NightgateService under a
 * technical user. Hosted: the nightgate-tx client against NIGHTGATE_API_URL
 * with the agent token (the hosted API has no anonymous reads). Same
 * parameters, same answer shape on both.
 *
 *   NIGHTGATE_VERIFY_VIA=hosted | plugin
 *   unset: hosted when the demo runs on the remote transport and the hosted
 *   API is configured, plugin otherwise.
 */
import cds from '@sap/cds';
import { hostedVerifyClient, remoteLaneConfigFromEnv } from './lane-remote';

export type VerifyRead = 'verifyAttestationState' | 'verifyPredicateState';

export function verifyVia(env: NodeJS.ProcessEnv = process.env): 'hosted' | 'plugin' {
    const v = String(env.NIGHTGATE_VERIFY_VIA ?? '').trim().toLowerCase();
    if (v === 'hosted' || v === 'plugin') return v;
    const hostedConfigured = !!String(env.NIGHTGATE_API_URL ?? '').trim() && !!String(env.DEMO_NIGHTGATE_AGENT_TOKEN ?? '').trim();
    return env.DEMO_TRANSPORT === 'remote' && hostedConfigured ? 'hosted' : 'plugin';
}

/** Whether the read surface can take the `network` override (NIGHTGATE >= 0.7.0). */
export function verifyNetworkOverrideAvailable(): boolean {
    if (verifyVia() === 'hosted') return true;
    return !!(cds.model?.definitions?.['NightgateService.verifyAttestationState'] as any)?.params?.network;
}

/** Whether a named parameter exists on the plugin's read surface (hosted: always, 0.21.x). */
export function verifyParamAvailable(read: VerifyRead, param: string): boolean {
    if (verifyVia() === 'hosted') return true;
    return !!(cds.model?.definitions?.[`NightgateService.${read}`] as any)?.params?.[param];
}

/**
 * Run one state read. Throws on transport errors (callers map that to
 * "unverified"); a negative answer is a normal `{ verified: false }`.
 */
export async function readState(read: VerifyRead, params: Record<string, unknown>): Promise<any> {
    if (verifyVia() === 'hosted') {
        const ng = await hostedVerifyClient(remoteLaneConfigFromEnv());
        return ng.callFunction(read, params as any);
    }
    const nightgate = await cds.connect.to('NightgateService');
    const verifier = new (cds.User as any)({ id: 'passport-verifier' });
    return (nightgate as any).tx({ user: verifier }, (tx: any) => tx.send(read, params));
}
