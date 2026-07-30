/**
 * Battery status lifecycle (EU Battery Regulation 2023/1542, Annex XIII 4(c)):
 * original -> repurposed | reused | remanufactured -> waste. Pure module, no
 * cds import.
 *
 * The status lives in the BatteryStatus PassportAttributes row (section
 * IdentifiersAndProductData, legitimateInterest, official longlist entry #11,
 * format String). It is part of the anchored payload hash, so a status change
 * drifts the passport and requires a re-anchor per the re-anchoring policy
 * (reason 'status-change'). Deliberately NOT in the telemetry allowlist; the
 * only write path is ProducerService.changeBatteryStatus.
 */

export const BATTERY_STATUS_VALUES = ['original', 'repurposed', 'reused', 'remanufactured', 'waste'] as const;
export type BatteryStatus = (typeof BATTERY_STATUS_VALUES)[number];

/**
 * Allowed transitions: a fresh battery can enter any second-life state or go
 * straight to waste; second-life states only ever end in waste; waste is
 * terminal. Lateral moves between second-life states are not modeled (extend
 * here if a real flow needs them).
 */
export const ALLOWED_TRANSITIONS: Record<BatteryStatus, readonly BatteryStatus[]> = {
    original: ['repurposed', 'reused', 'remanufactured', 'waste'],
    repurposed: ['waste'],
    reused: ['waste'],
    remanufactured: ['waste'],
    waste: [],
};

export function isBatteryStatus(v: unknown): v is BatteryStatus {
    return typeof v === 'string' && (BATTERY_STATUS_VALUES as readonly string[]).includes(v);
}

export type TransitionResult = { ok: true } | { ok: false; error: string };

export function validateTransition(from: unknown, to: unknown): TransitionResult {
    if (!isBatteryStatus(to)) {
        return { ok: false, error: `unknown battery status '${String(to)}' (allowed: ${BATTERY_STATUS_VALUES.join(', ')})` };
    }
    const current: BatteryStatus = isBatteryStatus(from) ? from : 'original';
    if (current === to) return { ok: false, error: `battery status is already '${current}'` };
    if (!ALLOWED_TRANSITIONS[current].includes(to)) {
        return {
            ok: false,
            error: `illegal battery status transition '${current}' -> '${to}'` +
                (ALLOWED_TRANSITIONS[current].length ? ` (allowed: ${ALLOWED_TRANSITIONS[current].join(', ')})` : ` ('${current}' is terminal)`),
        };
    }
    return { ok: true };
}

/** Status from a BatteryStatus row's valueJson; defensive default 'original'. */
export function parseBatteryStatus(valueJson: unknown): BatteryStatus {
    try {
        const v = JSON.parse(String(valueJson ?? ''));
        const s = v?.batteryStatusValues;
        return isBatteryStatus(s) ? s : 'original';
    } catch {
        return 'original';
    }
}

/** Guide-shape valueJson for a status; byte-identical to the seeded shape. */
export function encodeBatteryStatus(status: BatteryStatus): string {
    return JSON.stringify({ batteryStatusValues: status });
}

/**
 * DPP document status derived from the battery lifecycle: a waste battery's
 * passport reads as Archived, everything else as Active. These are the two
 * dppStatusValue values the official conformance artifacts use.
 */
export function dppStatusFor(status: BatteryStatus | undefined): 'Active' | 'Archived' {
    return status === 'waste' ? 'Archived' : 'Active';
}
