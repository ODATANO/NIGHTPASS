import { readState } from './verify-reader';

/** Outcome of an on-chain check: the effect is there, is definitely not, or cannot be told yet. */
export type ChainVerdict = 'confirmed' | 'failed' | 'unknown';

/**
 * Checks of an action's effect on chain: each reads the vault's state through the NIGHTGATE API.
 * A present effect is `confirmed`; anything else is `unknown`, never `failed`, so an unsettled action keeps waiting.
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
        return 'unknown'; // The API is unreachable. Stay pending.
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
    const wantsSchema = !!schemaId;
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
 * Confirm a disclosure grant/revoke effect: the grantee's entry on the
 * attester's record is there (grant) or gone (revoke). `grantee` is the
 * Bytes<32> grantee id, the same key the read gate matches on.
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
    const grantee = norm(o.grantee);
    if (!contractAddress || !payloadHash || !HEX64.test(attesterId) || !HEX64.test(grantee)) return 'unknown';
    try {
        const res: any = await readState('verifyDisclosureState', {
            contractAddress, attesterId, payloadHash, grantee, compiledArtifactRef: CONTRACT_REF
        });
        // A grant still there after a revoke, or not there yet after a grant,
        // is `unknown` (keep waiting), never `failed`.
        const granted = res?.granted === true;
        if (o.op === 'grant') return granted ? 'confirmed' : 'unknown';
        if (granted) return 'unknown';
        // A record the read cannot find has no grant either, so only a present record confirms a revoke.
        return verifyAttestState({ contractAddress, payloadHash, attesterId });
    } catch {
        return 'unknown'; // The API is unreachable. Leave the row pending; a later retry re-checks.
    }
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
 * without the attester the read cannot name it and stays 'unknown'.
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
    if (membership && !norm(o.setRoot)) return 'unknown';
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
        return 'unknown'; // The API is unreachable. Stay pending.
    }
}
