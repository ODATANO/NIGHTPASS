/**
 * Query-level disclosure guard (pure).
 *
 * Redacting rows AFTER the database read is not a disclosure boundary on its
 * own: the query itself still runs against the real values, so
 * `$filter=carbonFootprintKgCO2 lt 3000&$count=true` turns the row COUNT into
 * an oracle that reconstructs the exact confidential number a ZK predicate
 * exists to hide. This module finds the columns a query touches outside a
 * plain projection, so the service layer can refuse such reads.
 *
 * Dependency-free on purpose: pure CQN inspection, unit-tested.
 */

/**
 * Every column a CQN SELECT references OUTSIDE a plain projection: $filter,
 * $orderby, $apply aggregates, groupBy, having.
 *
 * A bare `{ref:[col]}` directly in `columns` is excluded on purpose: a plain
 * $select of a restricted column is harmless because the after-READ redaction
 * removes the value. A reference inside a function or expression is NOT
 * excluded, because its result survives redaction.
 */
export function probingRefs(node: unknown, inProjection = false, out = new Set<string>()): Set<string> {
    if (Array.isArray(node)) {
        for (const item of node) probingRefs(item, inProjection, out);
        return out;
    }
    if (!node || typeof node !== 'object') return out;
    const n = node as Record<string, unknown>;
    const isBareRef = Array.isArray(n.ref) && !n.func && !n.xpr;
    if (Array.isArray(n.ref) && !(inProjection && isBareRef)) {
        const col = n.ref[n.ref.length - 1];
        if (typeof col === 'string') out.add(col);
    }
    for (const [key, value] of Object.entries(n)) {
        if (key === 'ref') continue;
        // Inside a function or expression the projection exemption no longer
        // applies: sum(carbonFootprintKgCO2) leaks the value it aggregates.
        const stillProjection = inProjection && key !== 'func' && key !== 'xpr' && key !== 'args';
        probingRefs(value, stillProjection, out);
    }
    return out;
}

/**
 * The first restricted column a SELECT probes, or undefined when the query is
 * clean. `select` is the CQN `query.SELECT` object.
 */
export function restrictedProbe(select: unknown, restricted: readonly string[]): string | undefined {
    if (!select || typeof select !== 'object') return undefined;
    const s = select as Record<string, unknown>;
    const refs = new Set<string>();
    probingRefs(s.columns, true, refs);
    for (const part of [s.where, s.orderBy, s.having, s.groupBy]) probingRefs(part, false, refs);
    return restricted.find((c) => refs.has(c));
}
