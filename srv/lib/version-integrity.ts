/**
 * Cross-root version integrity: the claim a re-anchored passport actually
 * needs.
 *
 * A passport is re-anchored whenever its content changes (telemetry batch,
 * status change, data correction). Each version gets its own payload hash and
 * its own salted content root, so from the outside the two anchors look
 * unrelated: nobody can tell whether the operator only appended a telemetry
 * reading or quietly rewrote the carbon footprint.
 *
 * NIGHTGATE 0.16.0's `proveDocumentComparison` (mode 0, integrity) closes that
 * gap. It witnesses BOTH versions' openings plus the shared schema, recomputes
 * both content roots in-circuit, asserts them against the anchors and then
 * asserts that every slot OUTSIDE a public 16-bit mask holds the same value.
 * The values stay hidden; only "changed / did not change, per slot" is proven.
 *
 * The mask is the statement, so this module is where it is built and named:
 *   - mask 0 = "nothing in the provable panel changed" (the telemetry case:
 *     the payload hash moved, but every proven spec is identical);
 *   - a mask naming `recycledContentPct` = "only that figure was corrected".
 *
 * Slot order is the provable-field registry (PROVABLE_FIELDS); bit i frees
 * slot i. Padding slots are never freed: they are absent in both documents and
 * therefore equal anyway.
 */

import { PROVABLE_FIELDS, MERKLE_DEPTH, provableFieldKind } from './passport-anchor';
import { decodeDynamicValue } from './attribute-update';

/** Slots in the content tree (16 for a depth-4 tree). */
export const SLOT_COUNT = 1 << MERKLE_DEPTH;

/** Slots backed by a real provable field; the rest is canonical padding. */
export const REAL_SLOT_COUNT = PROVABLE_FIELDS.length;

/** Slot index of a provable field, or -1. */
export function slotOf(fieldName: string): number {
    return (PROVABLE_FIELDS as readonly string[]).indexOf(fieldName);
}

/**
 * Packed 16-bit allowed mask for the named fields (bit i = slot i MAY differ).
 * Unknown field names are a hard error: silently dropping one would widen the
 * claim's meaning in the safe-looking direction (fewer freed slots) but leave
 * the operator believing a change was covered.
 */
export function allowedMaskFor(fieldNames: readonly string[] = []): number {
    let mask = 0;
    for (const name of fieldNames) {
        const idx = slotOf(String(name));
        if (idx < 0) throw new Error(`'${name}' is not a provable field, so it has no slot to free`);
        mask |= (1 << idx);
    }
    // Mirrors the in-circuit guard: a mask that frees every REAL slot states
    // nothing at all ("everything may differ"). Rejecting here saves the
    // operator a proving run that ends in an opaque circuit abort.
    if (REAL_SLOT_COUNT > 0 && (mask & ((1 << REAL_SLOT_COUNT) - 1)) === ((1 << REAL_SLOT_COUNT) - 1)) {
        throw new Error('an allowed mask that frees every provable field claims nothing; constrain at least one field');
    }
    return mask;
}

/** The field names a mask frees, in slot order (the human form of the claim). */
export function fieldsFromMask(mask: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < REAL_SLOT_COUNT; i++) {
        if (mask & (1 << i)) out.push(PROVABLE_FIELDS[i]);
    }
    return out;
}

/** One-line description of what a mask claims, for logs and the cockpit. */
export function describeMask(mask: number): string {
    const freed = fieldsFromMask(mask);
    return freed.length === 0
        ? 'no provable field changed'
        : `only ${freed.join(', ')} may have changed`;
}

/**
 * Absence policy, mirroring the circuit: both absent is no difference,
 * present vs absent IS a difference, and a changed value is a difference.
 * Values are compared as the circuit sees them (scaled integer string for
 * uint slots, digest for bytes slots), never as raw input.
 */
export function slotsEqual(a?: SlotOpeningLike, b?: SlotOpeningLike): boolean {
    const pa = !!a?.present, pb = !!b?.present;
    if (!pa && !pb) return true;
    if (pa !== pb) return false;
    if (a?.valueDigest != null || b?.valueDigest != null) {
        return String(a?.valueDigest ?? '').toLowerCase() === String(b?.valueDigest ?? '').toLowerCase();
    }
    return String(a?.value ?? '') === String(b?.value ?? '');
}

export interface SlotOpeningLike {
    present: boolean;
    value?: string;
    valueDigest?: string;
}

/**
 * The first slot that differs although the mask does not free it, as a field
 * name (or null when the integrity claim holds).
 *
 * The circuit would reject such a proof anyway, but only after minutes of
 * local proving and with no indication of WHICH field broke it. Running the
 * same comparison off-chain first turns that into an immediate, named error.
 * It is a pre-flight, not the proof: the on-chain statement still rests
 * entirely on the circuit.
 */
export function firstUnmaskedDifference(
    slotsA: readonly SlotOpeningLike[],
    slotsB: readonly SlotOpeningLike[],
    mask: number
): string | null {
    for (let i = 0; i < REAL_SLOT_COUNT; i++) {
        if (mask & (1 << i)) continue;
        if (!slotsEqual(slotsA[i], slotsB[i])) return PROVABLE_FIELDS[i];
    }
    return null;
}

/**
 * How many REAL slots differ between two versions. This is the off-chain
 * counterpart of the diff claim's k: the operator asks for a lower bound, and
 * a k above this count could only fail in-circuit, so the caller rejects it
 * with the real number instead. Padding slots never count, they are absent in
 * both documents.
 */
export function countChangedSlots(
    slotsA: readonly SlotOpeningLike[],
    slotsB: readonly SlotOpeningLike[]
): number {
    let n = 0;
    for (let i = 0; i < REAL_SLOT_COUNT; i++) {
        if (!slotsEqual(slotsA[i], slotsB[i])) n++;
    }
    return n;
}

/**
 * The provable field values of an ARCHIVED version, read from its decrypted
 * canonical payload.
 *
 * Deliberately a mirror of the producer service's `fieldValuesFor`, which
 * reads the CURRENT rows: an archived version's older values survive nowhere
 * else. Both must extract the same fields the same way, or the rebuilt root of
 * version N-1 would not match what was anchored back then and the comparison
 * would fail with no useful message. The anchored root is the tripwire: the
 * caller rebuilds and compares before it proves anything.
 */
export function provableValuesFromPayload(payload: unknown): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    const doc = (payload ?? {}) as Record<string, unknown>;
    const battery = (Array.isArray(doc.batteries) ? doc.batteries[0] : undefined) as Record<string, unknown> | undefined;
    if (battery) {
        for (const field of PROVABLE_FIELDS) {
            const v = battery[field];
            if (v == null || v === '') continue;
            out[field] = provableFieldKind(field) === 'string' ? String(v) : Number(v);
        }
    }
    const recycled = Array.isArray(doc.recycledMaterials) ? doc.recycledMaterials : [];
    for (const entry of recycled as Record<string, unknown>[]) {
        const material = entry?.material;
        const pct = entry?.recycledPercentage;
        if (!material || pct == null) continue;
        const field = `recycled${String(material)}Pct`;
        if (slotOf(field) >= 0) out[field] = Number(pct);
    }
    // Dynamic (measured) slots ride in the payload's guide attribute list.
    // Same decoder as the live path, so an archived version rebuilds to the
    // root it was anchored under.
    const attributes = Array.isArray(doc.attributes) ? doc.attributes : [];
    for (const entry of attributes as Record<string, unknown>[]) {
        const attribute = String(entry?.attribute ?? '');
        if (slotOf(attribute) < 0) continue;
        const n = decodeDynamicValue(attribute, entry?.valueJson);
        if (n != null) out[attribute] = n;
    }
    return out;
}
