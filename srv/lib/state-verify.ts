import cds from '@sap/cds';
import type { ChainVerdict } from './chain-verify';

/**
 * Crawler-free verification of a wallet-submitted action's ON-CHAIN EFFECT.
 *
 * The tx-based path (srv/lib/chain-verify.ts) resolves a client-reported txHash
 * against the plugin's `midnight.Transactions` table, which only the block
 * crawler populates. With the crawler off (the demo default) that table stays
 * empty, so a wallet action can never self-confirm and its row is stuck PENDING.
 *
 * NIGHTGATE's state readers answer the stronger question instead: not "did this txHash
 * land?" but "does the AttestationVault ledger now reflect the intended effect?".
 * Both surfaces below read live contract state via the indexer
 * (`queryContractState`), so they work with the crawler disabled and verify the
 * outcome rather than the transaction mechanics (idempotent, self-healing):
 *
 *   - `verifyAttestationState`  confirms a payload hash is anchored in the vault.
 *   - `reindexDisclosures`      reconciles `midnight.DisclosureGrants` from live
 *                               state, after which we read back the grant's row.
 *
 * Both map an on-chain effect that is present to `confirmed`, and everything else
 * (absent yet, or no live provider configured) to `unknown`, never `failed`: a
 * not-yet-settled action must keep waiting, not be marked a failure on a negative
 * read. That leaves the tx-based verdict as the only source that can say `failed`.
 */

const CONTRACT_REF = 'attestation-vault';
const norm = (h?: string | null): string => String(h ?? '').replace(/^0x/, '').toLowerCase();

/**
 * Confirm an attest's effect: the passport's `payloadHash` is present in the
 * vault's attestation map (and, when `contentRoot` is given, that it is the
 * anchored root for that payload). Crawler-independent.
 */
export async function verifyAttestState(o: {
    contractAddress?: string | null;
    payloadHash?: string | null;
    contentRoot?: string | null;
}): Promise<ChainVerdict> {
    const contractAddress = norm(o.contractAddress);
    const payloadHash = norm(o.payloadHash);
    if (!contractAddress || !payloadHash) return 'unknown';
    try {
        const nightgate = await cds.connect.to('NightgateService');
        const res: any = await nightgate.send('verifyAttestationState', {
            contractAddress,
            payloadHash,
            ...(o.contentRoot ? { contentRoot: norm(o.contentRoot) } : {}),
            compiledArtifactRef: CONTRACT_REF
        });
        return res?.verified === true ? 'confirmed' : 'unknown';
    } catch {
        return 'unknown'; // No live provider or the plugin is unreachable. Stay pending.
    }
}

/**
 * Confirm a disclosure grant/revoke effect. Reindexes `midnight.DisclosureGrants`
 * from live on-chain state (`reindexDisclosures`), then reads back whether the
 * grant for `(contractAddress, payloadHash, grantee)` is now active (grant) or
 * absent/inactive (revoke). The `grantee` is the Bytes<32> grantee id: the same
 * key the read gate matches on, and exactly what the cockpit's partner picker sends.
 */
export async function verifyGrantState(o: {
    contractAddress?: string | null;
    payloadHash?: string | null;
    grantee?: string | null;
    op: 'grant' | 'revoke';
}): Promise<ChainVerdict> {
    const contractAddress = norm(o.contractAddress);
    const payloadHash = norm(o.payloadHash);
    const grantee = String(o.grantee ?? '');
    if (!contractAddress || !payloadHash || !grantee) return 'unknown';
    try {
        const nightgate = await cds.connect.to('NightgateService');
        await nightgate.send('reindexDisclosures', { contractAddress, compiledArtifactRef: CONTRACT_REF });
    } catch {
        return 'unknown'; // No live provider. Leave the row pending; a later retry re-checks.
    }
    let active = false;
    try {
        const rows: unknown = await cds.db.read('midnight.DisclosureGrants')
            .columns('active').where({ contractAddress, payloadHash, grantee, active: true });
        active = Array.isArray(rows) && rows.length > 0;
    } catch {
        return 'unknown'; // grants table absent
    }
    // A grant is confirmed once its row is active on-chain; a revoke once no
    // active grant remains. A still-active grant after a revoke, or a not-yet
    // -present grant, is `unknown` (keep waiting), never `failed`.
    if (o.op === 'grant') return active ? 'confirmed' : 'unknown';
    return active ? 'unknown' : 'confirmed';
}

/**
 * Confirm a field-bound predicate proof's effect crawler-free (NIGHTGATE
 * `verifyPredicateState`): the vault recorded a true result for the claim key
 * (payloadHash, fieldKey, predicate, threshold). The wallet flow always proves a
 * field-bound predicate, so `fieldKey` is the canonical field id. `threshold`
 * must be the SAME scaled integer the circuit hashed into the claim key; the
 * cockpit builds the proof and this call from one `raw x1000` value, so it is
 * passed straight through here (do NOT scale again).
 */
export async function verifyPredicateState(o: {
    contractAddress?: string | null;
    payloadHash?: string | null;
    fieldKey?: string | null;
    predicate: 'lessOrEqual' | 'greaterOrEqual';
    threshold: number;
}): Promise<ChainVerdict> {
    const contractAddress = norm(o.contractAddress);
    const payloadHash = norm(o.payloadHash);
    if (!contractAddress || !payloadHash) return 'unknown';
    try {
        const nightgate = await cds.connect.to('NightgateService');
        const res: any = await nightgate.send('verifyPredicateState', {
            contractAddress,
            payloadHash,
            ...(o.fieldKey ? { fieldKey: norm(o.fieldKey) } : {}),
            predicate: o.predicate,
            threshold: o.threshold,
            compiledArtifactRef: CONTRACT_REF
        });
        return res?.verified === true ? 'confirmed' : 'unknown';
    } catch {
        return 'unknown'; // No live provider or the plugin is unreachable. Stay pending.
    }
}
