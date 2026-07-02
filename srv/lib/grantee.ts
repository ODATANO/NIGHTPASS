import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Derive the 32-byte disclosure grantee id from a partner DID/BPN.
 *
 * MUST match NIGHTGATE's `deriveGranteeId('did', did)`
 * (@odatano/nightgate/srv/submission/grantee-identity.js): the `did` binding is
 * `sha256(utf8(did))` as 64-hex. Used both when registering a partner and when
 * the producer issues a grant, so the read-side lookup matches.
 */
export function granteeIdForDid(did: string): string {
    if (!did) throw new Error('did is required');
    return bytesToHex(sha256(new TextEncoder().encode(did)));
}
