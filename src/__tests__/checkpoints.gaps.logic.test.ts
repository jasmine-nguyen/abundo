// WHIT-477 QA gaps — adversarial edges of the checkpoint client rules the implementer's
// checkpoints.logic.test.ts leaves open: exact boundary lengths, the amount cap, non-adjacent
// duplicates that only collide after the sort, equal-amount sort stability, and an invalid
// (NaN) target. Pure; mirrors handler.py _validate_goal_checkpoints. No provider/network.
import { describe, it, expect } from '@jest/globals';
import {
  sortCheckpointsForDirection,
  checkpointsError,
  checkpointOutOfBoundsRows,
  CHECKPOINT_LABEL_MAX_LEN,
  CHECKPOINT_AMOUNT_MAX,
} from '../checkpoints';
import type { GoalCheckpointInput } from '../api';

const cp = (label: string, amount: number, id?: string): GoalCheckpointInput => ({ id, label, amount });

describe('checkpointsError — boundary lengths (gap)', () => {
  it('accepts a label of EXACTLY the max length', () => {
    // [G1] 100 chars is allowed; only 101 is rejected (implementer tested only the reject side).
    expect(checkpointsError([cp('x'.repeat(CHECKPOINT_LABEL_MAX_LEN), 1000)], 'grow', 5000)).toBeNull();
  });

  it('trims trailing whitespace before the length check (100 chars + spaces is fine)', () => {
    // [G2] A label that is 100 visible chars plus trailing spaces must not trip the cap.
    const label = `${'x'.repeat(CHECKPOINT_LABEL_MAX_LEN)}   `;
    expect(checkpointsError([cp(label, 1000)], 'grow', 5000)).toBeNull();
  });
});

describe('checkpointsError — amount cap boundary (gap)', () => {
  it('accepts a rung EXACTLY at the amount cap when the target is above it', () => {
    // [G3] amount === CHECKPOINT_AMOUNT_MAX is in-bounds (cap is an inclusive ceiling, matching
    // the server's _finite_number `value <= high`).
    expect(checkpointsError([cp('Max', CHECKPOINT_AMOUNT_MAX)], 'grow', CHECKPOINT_AMOUNT_MAX + 1)).toBeNull();
  });

  it('rejects a rung ABOVE the amount cap even when below the target', () => {
    // [G4] the cap bites before the < target rule: amount > cap but < target is still out.
    expect(checkpointsError(
      [cp('Over cap', CHECKPOINT_AMOUNT_MAX + 1)],
      'grow',
      CHECKPOINT_AMOUNT_MAX + 1000,
    )).not.toBeNull();
  });
});

describe('checkpointsError — non-adjacent duplicates (gap)', () => {
  it('rejects a dup that is only adjacent AFTER the sort (grow, entered out of order)', () => {
    // [G5] [1000, 3000, 1000] → sorted [1000, 1000, 3000]: the loop must compare sorted neighbours,
    // not input order.
    expect(checkpointsError(
      [cp('A', 1000), cp('B', 3000), cp('C', 1000)],
      'grow',
      5000,
    )).toMatch(/same amount/i);
  });

  it('rejects a non-adjacent dup on a paydown ladder too', () => {
    // [G6] [3000, 6000, 3000] → sorted desc [6000, 3000, 3000].
    expect(checkpointsError(
      [cp('A', 3000), cp('B', 6000), cp('C', 3000)],
      'paydown',
      0,
    )).toMatch(/same amount/i);
  });
});

describe('checkpointsError — paydown exactly-at a non-zero target (gap)', () => {
  it('rejects a paydown rung equal to a non-zero target (needs strictly above)', () => {
    // [G7] implementer only pinned exactly-at for target 0; lock the non-zero case.
    expect(checkpointsError([cp('At', 1000)], 'paydown', 1000)).toMatch(/above the target/i);
  });
});

describe('checkpointsError — an invalid (NaN) target blocks (gap)', () => {
  it('rejects otherwise-fine grow rungs when the target is NaN', () => {
    // [G8] defence-in-depth: even if the screen ever let a blank target through, the ladder can't
    // slip to the server as valid.
    expect(checkpointsError([cp('A', 1000), cp('B', 2000)], 'grow', NaN)).not.toBeNull();
  });
});

describe('sortCheckpointsForDirection — stability on equal amounts (gap)', () => {
  it('preserves input order for two rungs of equal amount (grow)', () => {
    // [G9] stable sort: a tie keeps insertion order, so the row a user typed first stays first
    // (matters for which duplicate the dup message points at, and for deterministic UI).
    const out = sortCheckpointsForDirection([cp('First', 2000), cp('Second', 2000)], 'grow');
    expect(out.map((c) => c.label)).toEqual(['First', 'Second']);
  });

  it('preserves input order for two rungs of equal amount (paydown)', () => {
    const out = sortCheckpointsForDirection([cp('First', 2000), cp('Second', 2000)], 'paydown');
    expect(out.map((c) => c.label)).toEqual(['First', 'Second']);
  });
});

describe('checkpointOutOfBoundsRows — cap ceiling (gap)', () => {
  it('flags a row above the amount cap even below the target', () => {
    // [G10] the live per-row warning must light the over-cap row.
    const rows = [cp('ok', 1000), cp('over cap', CHECKPOINT_AMOUNT_MAX + 1)];
    expect(checkpointOutOfBoundsRows(rows, 'grow', CHECKPOINT_AMOUNT_MAX + 1000)).toEqual([false, true]);
  });
});
