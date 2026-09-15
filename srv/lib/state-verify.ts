import cds from '@sap/cds';
import type { ChainVerdict } from './chain-verify';
import { readState, verifyParamAvailable } from './verify-reader';

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
 *   - `verifyAttestationState`  confirms a record is anchored in the vault.
 *   - `reindexDisclosures`      reconciles `midnight.DisclosureGrants` from live
 *                               state, after which we read back the grant's row.
 *
 * Records are keyed by attester AND payload (vault lineage 4). A read names the
 * record by `attesterId` + `payloadHash`, or resolves it through the bound
 * document id (`passportIdHash`); the `RecordSelector` carries whichever the
 * caller has. A row without an attester id and without a live binding cannot be
 * read and answers `unknown`.
 *
 * Both map an on-chain effect that is present to `confirmed`, and everything else
 * (absent yet, or no live provider configured) to `unknown`, never `failed`: a
 * not-yet-settled action must keep waiting, not be marked a failure on a negative
 * read. That leaves the tx-based verdict as the only source that can say `failed`.
 */

const CONTRACT_REF = 'attestation-vault';
const norm = (h?: string | null): string => String(h ?? '').replace(/^0x/, '').toLowerCase();
const HEX64 = /^[0-9a-f]{64}$/;

/** How a caller names the attester's record of a payload. */
export interface RecordSelector {
    contractAddress?: string | null;
    payloadHash?: string | null;
    /** The record owner. Preferred: exact, independent of the binding. */
    attesterId?: string | null;
    /** The bound document id (blake2b of the passport id); resolves the CURRENT binding only. */
    documentId?: string | null;
}

/**
 * The `verifyAttestationState` argument set for a selector, or null when the
 * record cannot be named (no attester id and no document id).
 */
export function recordSelectorArgs(o: RecordSelector): Record<string, string> | null {
    const contractAddress = norm(o.contractAddress);
    const payloadHash = norm(o.payloadHash);
    const attesterId = norm(o.attesterId);
    const documentId = norm(o.documentId);
    if (!contractAddress || !payloadHash) return null;
    if (HEX64.test(attesterId)) return { contractAddress, attesterId, payloadHash };
    if (HEX64.test(documentId)) return { contractAddress, documentId, payloadHash };
    return null;
}

/**
 * Confirm an attest's effect: the record is present in the vault's attestation
 * map (and, when `contentRoot` is given, that it is the anchored root for that
 * record). Crawler-independent.
 */
export async function verifyAttestState(o: RecordSelector & { contentRoot?: string | null }): Promise<ChainVerdict> {
    const sel = recordSelectorArgs(o);
    if (!sel) return 'unknown';
    try {
        const res: any = await readState('verifyAttestationState', {
            ...sel,
            ...(o.contentRoot ? { contentRoot: norm(o.contentRoot) } : {}),
            compiledArtifactRef: CONTRACT_REF
        });
        return res?.verified === true ? 'confirmed' : 'unknown';
    } catch {
        return 'unknown'; // No live provider or the plugin is unreachable. Stay pending.
    }
}

/**
 * The attester id of the record a document id currently resolves to, when
 * that record carries `payloadHash`. Used right after an anchor to stamp the
 * row with the identity the chain saw, whichever lane signed. Null when the
 * binding is absent, points at another payload, or the read is unavailable.
 */
export async function resolveAnchorAttester(o: {
    contractAddress?: string | null; documentId?: string | null; payloadHash?: string | null;
}): Promise<string | null> {
    const contractAddress = norm(o.contractAddress);
    const documentId = norm(o.documentId);
    const payloadHash = norm(o.payloadHash);
    if (!contractAddress || !HEX64.test(documentId) || !payloadHash) return null;
    try {
        const res: any = await readState('verifyAttestationState', {
            contractAddress, documentId, payloadHash, compiledArtifactRef: CONTRACT_REF
        });
        const id = norm(res?.attesterId);
        return res?.attested === true && HEX64.test(id) ? id : null;
    } catch {
        return null;
    }
}

/**
 * Three-way content-root state for the drift pre-flight: does the vault's
 * anchored root for this record match the given (freshly built) root?
 *   - 'match'    the record is attested and the anchored root equals ours
 *   - 'mismatch' the record is attested but the anchored root DIFFERS (the
 *                provable-field layout changed since the anchor; every claim
 *                would fail at local proving until a re-anchor)
 *   - 'unknown'  not attested here, or no live provider (callers proceed and
 *                let the circuit abort honestly)
 * Deliberately separate from verifyAttestState: the settlement verdicts must
 * never say failed on a negative read, but a drift pre-flight needs the
 * negative signal.
 */
export async function attestRootState(o: RecordSelector & {
    contentRoot?: string | null;
    /** Schema id of the provable-field layout; a mismatch of the ANCHORED schema counts as drift too. */
    schemaId?: string | null;
}): Promise<'match' | 'mismatch' | 'unknown'> {
    const sel = recordSelectorArgs(o);
    const contentRoot = norm(o.contentRoot);
    const schemaId = norm(o.schemaId);
    if (!sel || !contentRoot) return 'unknown';
    const wantsSchema = !!schemaId && verifyParamAvailable('verifyAttestationState', 'schemaId');
    try {
        const res: any = await readState('verifyAttestationState', {
            ...sel, contentRoot,
            ...(wantsSchema ? { schemaId } : {}),
            compiledArtifactRef: CONTRACT_REF
        });
        // With a contentRoot supplied, NIGHTGATE folds the root check into
        // `verified` (verified = attested && contentRootOk), so the drift
        // signal MUST branch on `attested` first: an attested record whose
        // anchored root differs is exactly the mismatch this reports.
        if (res?.attested !== true) return 'unknown';
        if (res?.contentRootOk === false) return 'mismatch';
        if (wantsSchema && res?.schemaOk === false) return 'mismatch';
        return 'match';
    } catch {
        return 'unknown';
    }
}

/**
 * Confirm a disclosure grant/revoke effect. Reindexes `midnight.DisclosureGrants`
 * from live on-chain state (`reindexDisclosures`), then reads back whether the
 * grant for `(contractAddress, payloadHash, grantee)` is now active (grant) or
 * absent/inactive (revoke). The `grantee` is the Bytes<32> grantee id: the same
 * key the read gate matches on, and exactly what the cockpit's partner picker sends.
 * With an `attesterId` the read-back is narrowed to that attester's record.
 */
export async function verifyGrantState(o: {
    contractAddress?: string | null;
    payloadHash?: string | null;
    attesterId?: string | null;
    grantee?: string | null;
    op: 'grant' | 'revoke';
}): Promise<ChainVerdict> {
    const contractAddress = norm(o.contractAddress);
    const payloadHash = norm(o.payloadHash);
    const attesterId = norm(o.attesterId);
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
            .columns('active')
            .where({ contractAddress, payloadHash, grantee, active: true, ...(HEX64.test(attesterId) ? { attesterId } : {}) });
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
 * Confirm a CROSS-ROOT claim crawler-free: the vault holds an unexpired claim
 * for the key (record A, record B, bound). The order of the two records is
 * part of the key, so A must be the older version. Both kinds share this:
 * integrity binds an allowed mask (upper bound on change), diff binds k
 * (lower bound). Each record is named by its attester (the versions of one
 * passport may carry different attesters after a handover).
 *
 * Used as the settlement check when the client's wait for the proof job runs
 * out: the cross-root circuit is the slowest one in the system, and a wait
 * that expires says nothing about whether the transaction landed. Mapping
 * present -> confirmed and everything else -> unknown keeps a timeout from
 * lying red about a claim that is on-chain.
 */
export async function verifyCrossRootState(o: {
    contractAddress?: string | null;
    payloadHashA?: string | null;
    payloadHashB?: string | null;
    attesterIdA?: string | null;
    /** Document B's attester; defaults to A's. */
    attesterIdB?: string | null;
    /** 'documentIntegrity' reads the mask as its bound, 'documentDiff' reads k. */
    kind: 'documentIntegrity' | 'documentDiff';
    bound: number;
}): Promise<ChainVerdict> {
    const contractAddress = norm(o.contractAddress);
    const payloadHash = norm(o.payloadHashA);
    const payloadHashB = norm(o.payloadHashB);
    const attesterId = norm(o.attesterIdA);
    const attesterIdB = norm(o.attesterIdB) || attesterId;
    if (!contractAddress || !payloadHash || !payloadHashB || !HEX64.test(attesterId)) return 'unknown';
    const needed = verifyParamAvailable('verifyPredicateState', o.kind === 'documentDiff' ? 'k' : 'allowedMask');
    if (!verifyParamAvailable('verifyPredicateState', 'payloadHashB') || !needed) return 'unknown';
    try {
        const res: any = await readState('verifyPredicateState', {
            contractAddress, attesterId, payloadHash, payloadHashB,
            ...(attesterIdB !== attesterId ? { attesterIdB } : {}),
            predicate: o.kind,
            ...(o.kind === 'documentDiff'
                ? { k: Number(o.bound ?? 0) }
                : { allowedMask: Number(o.bound ?? 0) }),
            compiledArtifactRef: CONTRACT_REF
        });
        return res?.verified === true ? 'confirmed' : 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Confirm a field-bound claim's effect crawler-free (NIGHTGATE
 * `verifyPredicateState`): the vault holds an unexpired claim for the key.
 * Numeric kinds: (record, fieldKey, predicate, threshold); `threshold`
 * must be the SAME scaled integer the circuit hashed into the claim key; the
 * cockpit builds the proof and this call from one `raw x1000` value, so it is
 * passed straight through here (do NOT scale again). Membership kind:
 * (record, fieldKey, 'setMembership', setRoot); threshold is not part of
 * the claim key and is omitted. The record is `attesterId` + `payloadHash`;
 * without the attester the read cannot name it and stays 'unknown'. On a
 * plugin that predates the setMembership kind (no `setRoot` param in the
 * model), a membership check returns 'unknown' instead of sending an arg the
 * action would reject.
 */
export async function verifyPredicateState(o: {
    contractAddress?: string | null;
    payloadHash?: string | null;
    attesterId?: string | null;
    fieldKey?: string | null;
    predicate: 'lessOrEqual' | 'greaterOrEqual' | 'setMembership';
    threshold?: number;
    setRoot?: string | null;
}): Promise<ChainVerdict> {
    const contractAddress = norm(o.contractAddress);
    const payloadHash = norm(o.payloadHash);
    const attesterId = norm(o.attesterId);
    if (!contractAddress || !payloadHash || !HEX64.test(attesterId)) return 'unknown';
    const membership = o.predicate === 'setMembership';
    if (membership) {
        const hasSetRootParam = verifyParamAvailable('verifyPredicateState', 'setRoot');
        if (!hasSetRootParam || !norm(o.setRoot)) return 'unknown';
    }
    try {
        const res: any = await readState('verifyPredicateState', {
            contractAddress,
            attesterId,
            payloadHash,
            ...(o.fieldKey ? { fieldKey: norm(o.fieldKey) } : {}),
            predicate: o.predicate,
            ...(membership ? { setRoot: norm(o.setRoot) } : { threshold: Number(o.threshold ?? 0) }),
            compiledArtifactRef: CONTRACT_REF
        });
        return res?.verified === true ? 'confirmed' : 'unknown';
    } catch {
        return 'unknown'; // No live provider or the plugin is unreachable. Stay pending.
    }
}
