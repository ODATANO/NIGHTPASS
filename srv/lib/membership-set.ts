/**
 * Membership-set tree for `proveFieldMembership`, built with the SDK's set-root rule.
 * Unlike the content tree it is not salted: its leaves are digests of public
 * allow-list values, and the padding repeats a real member.
 */

import {
    buildMembershipSet as ngBuildMembershipSet,
    membershipPathFor as ngMembershipPathFor,
    canonicalSetDigests,
} from '@odatano/nightgate-tx/set-root';
import { blake2b256Hex, loadPureCircuits } from './passport-anchor';
import { MAX_SET_VALUES, SET_MERKLE_DEPTH } from './claim-sets';

export interface MembershipSet {
    /** 64-hex canonical set root. */
    setRoot: string;
    /** DISTINCT member digests (post-dedupe), not the input length. */
    memberCount: number;
    /** blake2b-256 digest (64-hex) of the exact string value. */
    digestOf(value: string): string;
    /**
     * Depth-6 inclusion path for a member value (or a precomputed 64-hex
     * digest), or null when the value is not in the set.
     */
    proofFor(valueOrDigest: string): { setSiblings: string[]; setDirs: boolean[] } | null;
}

const HEX32 = /^[0-9a-f]{64}$/;

export async function buildMembershipSet(values: readonly string[]): Promise<MembershipSet> {
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error('membership set needs at least one allowed value');
    }
    const pure = await loadPureCircuits();
    const list = values.map((v) => String(v));

    const digests = canonicalSetDigests(list);
    if (digests.length > MAX_SET_VALUES) {
        throw new Error(`at most ${MAX_SET_VALUES} distinct allowed values (depth-${SET_MERKLE_DEPTH} set tree)`);
    }
    const { setRoot } = ngBuildMembershipSet(list, pure);
    const memberDigests = new Set(digests);

    return {
        setRoot,
        memberCount: digests.length,
        digestOf: (value: string) => blake2b256Hex(String(value)),
        proofFor(valueOrDigest: string) {
            const s = String(valueOrDigest ?? '');
            // A 64-hex input that is itself a member digest is taken as the
            // digest; anything else is digested as a raw value first.
            const digest = HEX32.test(s.toLowerCase()) && memberDigests.has(s.toLowerCase())
                ? s.toLowerCase()
                : blake2b256Hex(s);
            const path = ngMembershipPathFor(list, digest, pure);
            if (!path) return null;
            return { setSiblings: path.setSiblings, setDirs: path.setDirs };
        },
    };
}
