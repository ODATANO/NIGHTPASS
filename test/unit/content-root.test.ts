import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
    buildContentRoot, provableFieldKind, fieldKeyHex, blake2b256Hex,
    fromHex32, toHex, loadPureCircuits, schemaDescriptors, contentSchemaId, newSaltSeed,
    PROVABLE_FIELDS, BATTERY_PROVABLE_FIELDS, RECYCLED_MATERIAL_FIELDS, DYNAMIC_PROVABLE_FIELDS,
    STRING_PROVABLE_FIELDS, MERKLE_DEPTH, VALUE_SCALE,
} from '../../srv/lib/passport-anchor';

// The content tree carries three leaf encodings since NIGHTGATE 0.16.0 (v4):
// numeric leaves (leafHash(fieldKey, scaledValue, salt)), string leaves
// (bytesLeafHash(fieldKey, blake2b256(exact string), salt)) and salted ABSENT
// leaves for the padding slots. Every leaf's salt comes from a per-document
// 32-byte seed, so the tree is only reproducible with that seed: the anchor
// stores it, the proof paths reuse it.

const NUMERIC_VALUES: Record<string, number> = {
    carbonFootprintKgCO2: 3500, capacityKwh: 75, recycledContentPct: 16,
    cycleLife: 1800, roundTripEfficiencyPct: 92, leadContentPpm: 40,
    recycledCoPct: 16, recycledLiPct: 6, recycledNiPct: 6,
};

const SEED = 'a'.repeat(64);

describe('provable-field registry', () => {
    it('keeps numeric fields first and string fields after them', () => {
        const numericCount = BATTERY_PROVABLE_FIELDS.length + RECYCLED_MATERIAL_FIELDS.length
            + DYNAMIC_PROVABLE_FIELDS.length;
        assert.deepEqual(
            PROVABLE_FIELDS.slice(numericCount),
            STRING_PROVABLE_FIELDS,
            'string fields must stay appended AFTER the numeric leaves'
        );
        assert.ok(PROVABLE_FIELDS.length <= (1 << MERKLE_DEPTH));
        assert.equal(provableFieldKind('cellChemistry'), 'string');
        assert.equal(provableFieldKind('capacityKwh'), 'numeric');
        assert.equal(provableFieldKind('CapacityFade'), 'numeric', 'measured slots are uint slots');
        assert.equal(provableFieldKind('nope'), null);
    });
});

describe('schema descriptors', () => {
    it('describes every slot: uint fields, bytes fields, canonical padding', async () => {
        const pc = await loadPureCircuits();
        const schema = schemaDescriptors(pc);
        assert.equal(schema.length, 1 << MERKLE_DEPTH);
        assert.deepEqual(schema[0], { fieldKey: fieldKeyHex('carbonFootprintKgCO2'), kind: 0, scale: String(VALUE_SCALE) });
        const chemIdx = PROVABLE_FIELDS.indexOf('cellChemistry');
        assert.deepEqual(schema[chemIdx], { fieldKey: fieldKeyHex('cellChemistry'), kind: 1, scale: '0' });
        // Padding slots must carry the CONTRACT's empty-leaf key, not one of
        // ours: proveDocumentComparison asserts that shape in-circuit.
        const pad = schema[schema.length - 1];
        assert.deepEqual(pad, { fieldKey: toHex(pc.emptyLeafKey()), kind: 2, scale: '0' });
    });

    it('the schema id is deterministic and matches the built tree', async () => {
        const tree = await buildContentRoot(NUMERIC_VALUES, { saltSeed: SEED });
        assert.equal(tree.schemaId, await contentSchemaId());
        assert.match(tree.schemaId, /^[0-9a-f]{64}$/);
    });
});

describe('buildContentRoot (v4 salted)', () => {
    it('folds to the manually built 16-leaf tree with per-slot salts', async () => {
        const pc = await loadPureCircuits();
        const seed = fromHex32(SEED);
        const schema = schemaDescriptors(pc);
        const leaves: Uint8Array[] = [];
        for (let i = 0; i < (1 << MERKLE_DEPTH); i++) {
            const salt = pc.slotSalt(seed, BigInt(i));
            const f = PROVABLE_FIELDS[i];
            leaves.push(f != null && NUMERIC_VALUES[f] != null
                ? pc.leafHash(fromHex32(fieldKeyHex(f)), BigInt(Math.round(NUMERIC_VALUES[f] * VALUE_SCALE)), salt)
                : pc.absentLeafHash(fromHex32(schema[i].fieldKey), salt));
        }
        let level = leaves;
        for (let d = 0; d < MERKLE_DEPTH; d++) {
            const next: Uint8Array[] = [];
            for (let i = 0; i < level.length; i += 2) next.push(pc.nodeHash(level[i], level[i + 1]));
            level = next;
        }
        const tree = await buildContentRoot(NUMERIC_VALUES, { saltSeed: SEED });
        assert.equal(tree.contentRoot, toHex(level[0]));
    });

    it('the same seed reproduces the root; a different seed does not', async () => {
        const a = await buildContentRoot(NUMERIC_VALUES, { saltSeed: SEED });
        const b = await buildContentRoot(NUMERIC_VALUES, { saltSeed: SEED });
        assert.equal(b.contentRoot, a.contentRoot);
        assert.equal(b.saltSeed, SEED);

        const other = await buildContentRoot(NUMERIC_VALUES, { saltSeed: 'b'.repeat(64) });
        assert.notEqual(other.contentRoot, a.contentRoot,
            'a fresh seed must yield a different root (that is why the anchor persists it)');

        // No seed given: a random one is generated and reported back.
        const rnd = await buildContentRoot(NUMERIC_VALUES);
        assert.match(rnd.saltSeed, /^[0-9a-f]{64}$/);
        assert.notEqual(rnd.saltSeed, SEED);
    });

    it('adding a chemistry changes the root; its proof is the string variant and folds back', async () => {
        const bare = await buildContentRoot(NUMERIC_VALUES, { saltSeed: SEED });
        const withChem = await buildContentRoot({ ...NUMERIC_VALUES, cellChemistry: 'Li-ion NMC' }, { saltSeed: SEED });
        assert.notEqual(withChem.contentRoot, bare.contentRoot);

        const proof = withChem.proofFor('cellChemistry');
        assert.ok(proof && proof.kind === 'string');
        assert.equal(proof.valueDigest, blake2b256Hex('Li-ion NMC'));
        assert.equal(proof.siblings.length, MERKLE_DEPTH);
        assert.match(proof.salt, /^[0-9a-f]{64}$/);

        const pc = await loadPureCircuits();
        let node = pc.bytesLeafHash(fromHex32(proof.fieldKey), fromHex32(proof.valueDigest), fromHex32(proof.salt));
        for (let d = 0; d < MERKLE_DEPTH; d++) {
            const sib = fromHex32(proof.siblings[d]);
            node = proof.dirs[d] ? pc.nodeHash(node, sib) : pc.nodeHash(sib, node);
        }
        assert.equal(toHex(node), withChem.contentRoot);

        // Numeric proofs keep their kind, carry their own slot salt and still
        // fold under the new root.
        const num = withChem.proofFor('capacityKwh');
        assert.ok(num && num.kind === 'numeric');
        assert.equal(num.value, String(75 * VALUE_SCALE));
        let n2 = pc.leafHash(fromHex32(num.fieldKey), BigInt(num.value), fromHex32(num.salt));
        for (let d = 0; d < MERKLE_DEPTH; d++) {
            const sib = fromHex32(num.siblings[d]);
            n2 = num.dirs[d] ? pc.nodeHash(n2, sib) : pc.nodeHash(sib, n2);
        }
        assert.equal(toHex(n2), withChem.contentRoot);
    });

    it('the opening covers all 16 slots in slot order, absent ones marked', async () => {
        const tree = await buildContentRoot({ ...NUMERIC_VALUES, cellChemistry: 'Li-ion NMC' }, { saltSeed: SEED });
        assert.equal(tree.opening.saltSeed, SEED);
        assert.equal(tree.opening.slots.length, 1 << MERKLE_DEPTH);
        assert.deepEqual(tree.opening.slots[0], { present: true, value: String(3500 * VALUE_SCALE) });
        const chemIdx = PROVABLE_FIELDS.indexOf('cellChemistry');
        assert.deepEqual(tree.opening.slots[chemIdx], { present: true, valueDigest: blake2b256Hex('Li-ion NMC') });
        assert.deepEqual(tree.opening.slots[15], { present: false });
    });

    it('rejects a non-numeric value on a numeric field with a named error', async () => {
        await assert.rejects(
            () => buildContentRoot({ ...NUMERIC_VALUES, capacityKwh: 'not-a-number' }, { saltSeed: SEED }),
            /field 'capacityKwh' value is not numeric/
        );
    });

    it('newSaltSeed yields distinct 32-byte seeds', () => {
        const a = newSaltSeed(), b = newSaltSeed();
        assert.match(a, /^[0-9a-f]{64}$/);
        assert.notEqual(a, b);
    });
});

// Golden vector against NIGHTGATE's OWN document-proof builder: our tree is a
// field-registry-specific twin of it, and a byte-level drift would only show
// up as claims failing at local proving time (minutes of wasted proving, then
// an opaque abort). The package does not export the module, so it is required
// by absolute path (the deep-import trap: `exports` does not cover it).
describe('parity with NIGHTGATE buildDocumentContentRoot', () => {
    it('produces the same root, schema id and opening for the same seed', async () => {
        const require_ = createRequire(import.meta.url);
        const pkgRoot = path.dirname(require_.resolve('@odatano/nightgate/package.json'));
        const ng = require_(path.join(pkgRoot, 'srv', 'submission', 'document-proof.js'));

        const values = { ...NUMERIC_VALUES, cellChemistry: 'Li-ion NMC' };
        const specs = PROVABLE_FIELDS.map((f) => (
            provableFieldKind(f) === 'string'
                ? { field: f, kind: 'bytes' }
                : { field: f, kind: 'uint', scale: VALUE_SCALE }
        ));

        const pc = await loadPureCircuits();
        const theirs = ng.buildDocumentContentRoot(values, specs, pc, fromHex32(SEED));
        const ours = await buildContentRoot(values, { saltSeed: SEED });

        assert.equal(ours.contentRoot, theirs.contentRoot);
        assert.equal(ours.schemaId, theirs.schemaId);
        assert.deepEqual(ours.schema, theirs.schema.map((d: any) => ({ ...d, kind: Number(d.kind) })));
        assert.deepEqual(ours.opening, theirs.opening);

        // And the per-field witness material (salt + path) matches too.
        const mine = ours.proofFor('capacityKwh');
        const hers = theirs.fields.find((f: any) => f.field === 'capacityKwh');
        assert.ok(mine && mine.kind === 'numeric');
        assert.equal(mine.salt, hers.salt);
        assert.equal(mine.value, hers.value);
        assert.deepEqual(mine.siblings, hers.siblings);
        assert.deepEqual(mine.dirs, hers.dirs);
    });
});
