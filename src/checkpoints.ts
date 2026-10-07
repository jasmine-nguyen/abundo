// Client-side rules for a goal's checkpoint ladder (WHIT-477), mirrored from the server
// (lambda_api/handler.py _validate_goal_checkpoints) so the editor blocks a bad ladder with a
// friendly message before any round-trip, instead of a 400 + toast. The one source of truth
// shared by app/goal/edit.tsx and its tests. Kept in sync with the server constants by the
// twin-guard tests/lambda_api/test_goal_checkpoint_cap_sync.py.

import type { GoalCheckpoint, GoalCheckpointInput, GoalRecord } from './api';
import type { BalanceGoalView } from './context';

export const CHECKPOINT_MAX_COUNT = 20;
export const CHECKPOINT_LABEL_MAX_LEN = 100;
export const CHECKPOINT_AMOUNT_MAX = 1_000_000_000;

export type Direction = GoalRecord['direction'];

// A goal's checkpoints climb toward a savings target and fall toward a debt target, so a ladder is
// sorted by amount: ascending for grow, descending for paydown. Stable + non-mutating; the server
// rejects an out-of-order list, so the editor always sends the sorted order.
export function sortCheckpointsForDirection<T extends GoalCheckpointInput>(checkpoints: T[], direction: Direction): T[] {
  const sign = direction === 'grow' ? 1 : -1;
  return [...checkpoints].sort((a, b) => sign * (a.amount - b.amount));
}

// True when this amount isn't a step toward the target: a grow rung must sit above 0 and below the
// target, a paydown rung must sit above the target. Mirrors handler.py's per-rung bound. NaN (a
// blank/garbage amount) is always out of bounds.
function amountOutOfBounds(amount: number, direction: Direction, targetAmount: number): boolean {
  if (!Number.isFinite(amount) || amount > CHECKPOINT_AMOUNT_MAX) return true;
  if (direction === 'grow') return !(amount > 0 && amount < targetAmount);
  return !(amount > targetAmount);
}

// Which rows are out of bounds against the target — powers the editor's live per-row warning.
// Pure; independent of order (that's checkpointsError's job).
export function checkpointOutOfBoundsRows(
  checkpoints: GoalCheckpointInput[],
  direction: Direction,
  targetAmount: number,
): boolean[] {
  return checkpoints.map((cp) => amountOutOfBounds(cp.amount, direction, targetAmount));
}

// Validate a ladder the way the server does: at most 20 rungs, each with a non-empty label
// (≤100 chars) and an in-bounds amount, and — after sorting into the goal's direction — strictly
// monotonic (so no two rungs share an amount, matching the server's strict ordering). An EMPTY
// ladder is valid (a goal may have none, unlike a mortgage plan). Returns a plain-language
// message, or null when the ladder is fine.
export function checkpointsError(
  checkpoints: GoalCheckpointInput[],
  direction: Direction,
  targetAmount: number,
): string | null {
  if (checkpoints.length === 0) return null;
  if (checkpoints.length > CHECKPOINT_MAX_COUNT) {
    return `You can have at most ${CHECKPOINT_MAX_COUNT} checkpoints.`;
  }

  for (const cp of checkpoints) {
    const label = cp.label.trim();
    if (label === '') return 'Give every checkpoint a name.';
    if (label.length > CHECKPOINT_LABEL_MAX_LEN) {
      return `A checkpoint name can be at most ${CHECKPOINT_LABEL_MAX_LEN} characters.`;
    }
    if (amountOutOfBounds(cp.amount, direction, targetAmount)) {
      return direction === 'grow'
        ? 'Each checkpoint must be above $0 and below the target amount.'
        : 'Each checkpoint must be above the target amount.';
    }
  }

  const sorted = sortCheckpointsForDirection(checkpoints, direction);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].amount === sorted[i - 1].amount) {
      return "Two checkpoints can't have the same amount.";
    }
  }
  return null;
}

export interface CheckpointProgressRow {
  checkpoint: GoalCheckpoint;
  reached: boolean | null;
  toGo: number | null;
}

// WHIT-812 / WHIT-817: per checkpoint, reached or how much is left, plus the next one to reach.
// Rows come back in climb order (sortCheckpointsForDirection), so `next` is the closest unreached
// one even for a ladder saved out of order. `reached` is looked up by the checkpoint's STORED index,
// because balanceGoalView maps over stored order. toGo rounds up so a sub-dollar gap never reads "$0".
export function checkpointProgress(
  checkpoints: GoalCheckpoint[],
  direction: Direction,
  view: Pick<BalanceGoalView, 'currentAmount' | 'checkpointReached'>,
): { rows: CheckpointProgressRow[]; next: CheckpointProgressRow | null; allReached: boolean } {
  const current = view.currentAmount;
  const rows = sortCheckpointsForDirection(checkpoints, direction).map((checkpoint) => {
    const reached = view.checkpointReached?.[checkpoints.indexOf(checkpoint)] ?? null;
    if (current == null || reached) return { checkpoint, reached, toGo: null };
    const gap = direction === 'grow' ? checkpoint.amount - current : current - checkpoint.amount;
    return { checkpoint, reached, toGo: Math.ceil(gap) };
  });
  return {
    rows,
    next: rows.find((row) => row.reached === false) ?? null,
    allReached: rows.length > 0 && rows.every((row) => row.reached === true),
  };
}
