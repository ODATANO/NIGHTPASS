/**
 * Crash recovery for in-flight on-chain work (pure decision logic).
 *
 * Anchoring, proving, granting and registering all run DETACHED after the
 * request commits: the row is written as `anchoring` / `pending` and only an
 * in-process closure moves it on. A restart between those two points (routine
 * on a deployment with a nightly cron) therefore strands the row forever, and
 * for passports the anchor path then also refuses a retry, because a row that
 * looks in-flight blocks re-anchoring the same content.
 *
 * This module decides what a boot-time sweep should do with such a row. The
 * IO (reading rows, re-verifying on-chain, writing verdicts) stays in the
 * service; only the decision is here, so it can be unit-tested.
 */

import type { ChainVerdict } from './chain-verify';

export interface StuckRow {
    /** How long the row has been sitting in its in-flight state, in ms. */
    ageMs: number;
    /** True when the row carries enough data to re-check the chain. */
    checkable: boolean;
}

export type SweepAction =
    /** Too young to judge: a detached runner of THIS process may still own it. */
    | { kind: 'leave' }
    /** Old enough and re-checkable: ask the chain what really happened. */
    | { kind: 'recheck' }
    /** Old enough and not re-checkable: close it out honestly as failed. */
    | { kind: 'fail'; reason: string };

/**
 * A row younger than this is left alone: it may belong to a detached runner
 * that is still working (a cold wallet sync plus proving can take minutes).
 * Anything older than this cannot be in flight in a freshly started process.
 */
export const STUCK_AFTER_MS = 20 * 60_000;

/**
 * What to do with one in-flight row at boot. `now`-relative age is passed in
 * so the caller controls the clock (and tests do not need timers).
 */
export function sweepAction(row: StuckRow, stuckAfterMs = STUCK_AFTER_MS): SweepAction {
    if (row.ageMs < stuckAfterMs) return { kind: 'leave' };
    if (row.checkable) return { kind: 'recheck' };
    return { kind: 'fail', reason: 'interrupted by a server restart before the transaction was submitted' };
}

/**
 * Translate a re-check verdict into the final row state. `unknown` deliberately
 * becomes `failed` here and NOT `succeeded`: at this point the row is old, the
 * process that owned it is gone, and claiming success we cannot prove would be
 * the one lie this system must never tell. A re-anchor produces a fresh,
 * verifiable version; a wrongly-green row would not.
 */
export function verdictToStatus(verdict: ChainVerdict): { status: 'succeeded' | 'failed'; reason?: string } {
    if (verdict === 'confirmed') return { status: 'succeeded' };
    if (verdict === 'failed') {
        return { status: 'failed', reason: 'not found on-chain after a server restart' };
    }
    return { status: 'failed', reason: 'unconfirmed after a server restart (chain state could not be read)' };
}
