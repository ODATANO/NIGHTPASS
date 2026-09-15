import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMembershipSet } from '../../srv/lib/membership-set';
import { CLAIM_SETS, claimSetById, MAX_SET_VALUES } from '../../srv/lib/claim-sets';
import { blake2b256Hex, fromHex32, toHex, loadPureCircuits, STRING_PROVABLE_FIELDS } from '../../srv/lib/passport-anchor';

// Golden vectors, recomputed for the NIGHTGATE 0.24 (vault lineage 4)
// artifact. The tree rule has ONE implementation (we delegate to the
// platform's set-root module), so these guard the ARTIFACT GENERATION, not
// two implementations against each other: if a future compactc or runtime
// upgrade moves the roots again, this test fails FIRST, and the consequence
// is a vault redeploy plus re-anchor, not a silent claim mismatch.
//
// Earlier generations, for the record (do not "restore" them):
//   0.16.x (lineage 2/3)  chemistry-known       ef478cbb642f485da7e98494a06c334b097118f469e6d7a07f966d7537bdc500
//                         chemistry-cobalt-free b79d32bae032f4d803bf925cb0d8cd617c00d925898f8b26a6ee92d5ac753700
//   pre-0.16              chemistry-known       0f9578be18a29a5ba5e941be2f8e7f8e80b3fc25f0389b6f4f35a83528aa94be
//                         chemistry-cobalt-free abf1bb26515d2e02ecd260687f2c9adad70ab479390843ae467d8e3d7af1a25f
const GOLDEN = [
    { setId: 'chemistry-known', memberCount: 10, setRoot: '3e2d296894bf5a16be7a9179b3475b9827c48bf7f2dfb8a34b00dccad6078c00' },
    { setId: 'chemistry-cobalt-free', memberCount: 5, setRoot: '0ff76ebc88dbb407e5f657e65a3baf220f630350a8df6f9a8d3409ef7b3f5700' },
];
const SMALL_FIXTURE = {
    values: ['Li-ion LFP', 'Li-ion NMC', 'Na-ion'],
    setRoot: '60806051dfa1fef526ea647ad450e86a5b6816a77cf67c29aa3f4c9e870b2500',
};

describe('buildMembershipSet', () => {
    it('reproduces the NIGHTGATE golden roots for every catalog set', async () => {
        for (const g of GOLDEN) {
            const set = claimSetById(g.setId)!;
            const built = await buildMembershipSet(set.values);
            assert.equal(built.memberCount, g.memberCount, g.setId);
            assert.equal(built.setRoot, g.setRoot, g.setId);
        }
    });

    it('reproduces the small golden fixture and is order-insensitive with dedupe', async () => {
        const a = await buildMembershipSet(SMALL_FIXTURE.values);
        assert.equal(a.setRoot, SMALL_FIXTURE.setRoot);
        const b = await buildMembershipSet(['Na-ion', 'Li-ion NMC', 'Li-ion LFP', 'Na-ion']);
        assert.equal(b.setRoot, a.setRoot);
        assert.equal(b.memberCount, 3);
    });

    it('padding repeats the last member digest (63 vs 64 values differ)', async () => {
        const values63 = Array.from({ length: 63 }, (_, i) => `v${i}`);
        const values64 = [...values63, 'v63'];
        const a = await buildMembershipSet(values63);
        const b = await buildMembershipSet(values64);
        assert.notEqual(a.setRoot, b.setRoot);
    });

    it('proofFor folds back to the root; non-members return null', async () => {
        const set = await buildMembershipSet(SMALL_FIXTURE.values);
        const proof = set.proofFor('Li-ion NMC');
        assert.ok(proof);
        assert.equal(proof.setSiblings.length, 6);
        assert.equal(proof.setDirs.length, 6);
        // Re-fold with the artifact circuits: leaf -> root must equal setRoot.
        const pc = await loadPureCircuits();
        let node = pc.setLeafHash(fromHex32(blake2b256Hex('Li-ion NMC')));
        for (let d = 0; d < 6; d++) {
            const sib = fromHex32(proof.setSiblings[d]);
            node = proof.setDirs[d] ? pc.nodeHash(node, sib) : pc.nodeHash(sib, node);
        }
        assert.equal(toHex(node), set.setRoot);
        // Exact-string rule: a different spelling is not a member.
        assert.equal(set.proofFor('li-ion nmc'), null);
        assert.equal(set.proofFor('Unobtainium'), null);
        // A precomputed member digest resolves too.
        assert.ok(set.proofFor(blake2b256Hex('Na-ion')));
    });

    it('rejects empty and oversized sets', async () => {
        await assert.rejects(() => buildMembershipSet([]), /at least one/);
        const tooMany = Array.from({ length: MAX_SET_VALUES + 1 }, (_, i) => `v${i}`);
        await assert.rejects(() => buildMembershipSet(tooMany), /at most 64 distinct/);
    });
});

describe('claim-set catalog', () => {
    it('every set has 1..64 distinct values and a unique id', () => {
        const ids = new Set<string>();
        for (const s of CLAIM_SETS) {
            assert.ok(!ids.has(s.id), `duplicate set id ${s.id}`);
            ids.add(s.id);
            const distinct = new Set(s.values);
            assert.ok(distinct.size >= 1 && distinct.size <= MAX_SET_VALUES, s.id);
            assert.equal(distinct.size, s.values.length, `${s.id} carries duplicate values`);
            for (const v of s.values) assert.equal(v, v.trim(), `${s.id}: '${v}' has stray whitespace`);
        }
    });

    it('every set targets a registered string provable field', () => {
        for (const s of CLAIM_SETS) {
            assert.ok((STRING_PROVABLE_FIELDS as readonly string[]).includes(s.sourceField),
                `${s.id}: '${s.sourceField}' is not a string provable field`);
        }
    });

    it('cobalt-free is a strict subset of the known chemistries', () => {
        const known = new Set(claimSetById('chemistry-known')!.values);
        const cofree = claimSetById('chemistry-cobalt-free')!.values;
        for (const v of cofree) assert.ok(known.has(v), `'${v}' not in chemistry-known`);
        assert.ok(cofree.length < known.size);
    });
});
