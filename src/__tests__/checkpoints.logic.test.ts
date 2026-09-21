// Logic tests for the goal-checkpoint client rules (WHIT-477) — the sort + validation the editor
// runs before saving, mirrored from the server (lambda_api/handler.py _validate_goal_checkpoints).
// Pure; no provider/network.
import { describe, it, expect } from '@jest/globals';
import {
  sortCheckpointsForDirection,
  checkpointsError,
  checkpointOutOfBoundsRows,
  CHECKPOINT_MAX_COUNT,
  CHECKPOINT_LABEL_MAX_LEN,
} from '../checkpoints';
import type { GoalCheckpointInput } from '../api';

const cp = (label: string, amount: number, id?: string): GoalCheckpointInput => ({ id, label, amount });

describe('sortCheckpointsForDirection', () => {
  it('sorts ascending for a grow goal', () => {
    const out = sortCheckpointsForDirection([cp('C', 4000), cp('A', 1000), cp('B', 2500)], 'grow');
    expect(out.map((c) => c.amount)).toEqual([1000, 2500, 4000]);
  });

  it('sorts descending for a paydown goal', () => {
    const out = sortCheckpointsForDirection([cp('A', 3000), cp('C', 500), cp('B', 6000)], 'paydown');
    expect(out.map((c) => c.amount)).toEqual([6000, 3000, 500]);
  });

  it('does not mutate the input', () => {
    const input = [cp('B', 2000), cp('A', 1000)];
    sortCheckpointsForDirection(input, 'grow');
    expect(input.map((c) => c.amount)).toEqual([2000, 1000]);
  });
});

describe('checkpointsError', () => {
  it('accepts a valid grow ladder (target 5000)', () => {
    expect(checkpointsError([cp('A', 1000), cp('B', 2500), cp('C', 4000)], 'grow', 5000)).toBeNull();
  });

  it('accepts a valid paydown ladder (target 0)', () => {
    expect(checkpointsError([cp('A', 6000), cp('B', 3000), cp('C', 500)], 'paydown', 0)).toBeNull();
  });

  it('accepts an empty ladder (a goal may have none)', () => {
    expect(checkpointsError([], 'grow', 5000)).toBeNull();
  });

  it('accepts rows entered OUT of order (they get sorted before send)', () => {
    expect(checkpointsError([cp('B', 4000), cp('A', 1000)], 'grow', 5000)).toBeNull();
  });

  it('rejects a blank label', () => {
    expect(checkpointsError([cp('   ', 1000)], 'grow', 5000)).toMatch(/name/i);
  });

  it('rejects a label over the length cap', () => {
    expect(checkpointsError([cp('x'.repeat(CHECKPOINT_LABEL_MAX_LEN + 1), 1000)], 'grow', 5000)).toMatch(/characters/i);
  });

  it('rejects a grow rung at or above the target', () => {
    expect(checkpointsError([cp('At', 5000)], 'grow', 5000)).toMatch(/below the target/i);
    expect(checkpointsError([cp('Over', 6000)], 'grow', 5000)).toMatch(/below the target/i);
  });

  it('rejects a grow rung of 0', () => {
    expect(checkpointsError([cp('Zero', 0)], 'grow', 5000)).toMatch(/above \$0/i);
  });

  it('rejects a paydown rung at or below the target', () => {
    expect(checkpointsError([cp('At', 0)], 'paydown', 0)).toMatch(/above the target/i);
    expect(checkpointsError([cp('Below', 500)], 'paydown', 1000)).toMatch(/above the target/i);
  });

  it('rejects a blank / garbage amount (NaN)', () => {
    expect(checkpointsError([cp('X', NaN)], 'grow', 5000)).not.toBeNull();
  });

  it('rejects two rungs with the same amount (dup after sort)', () => {
    expect(checkpointsError([cp('A', 2000), cp('B', 2000)], 'grow', 5000)).toMatch(/same amount/i);
  });

  it('rejects more than the max number of rungs', () => {
    const ladder = Array.from({ length: CHECKPOINT_MAX_COUNT + 1 }, (_, n) => cp(`S${n}`, (n + 1) * 100));
    expect(checkpointsError(ladder, 'grow', 100000)).toMatch(new RegExp(`${CHECKPOINT_MAX_COUNT}`));
  });

  it('accepts exactly the max number of rungs', () => {
    const ladder = Array.from({ length: CHECKPOINT_MAX_COUNT }, (_, n) => cp(`S${n}`, (n + 1) * 100));
    expect(checkpointsError(ladder, 'grow', 100000)).toBeNull();
  });
});

describe('checkpointOutOfBoundsRows', () => {
  it('flags only the out-of-bounds rows, in order', () => {
    const rows = [cp('ok', 1000), cp('too high', 6000), cp('blank', NaN)];
    expect(checkpointOutOfBoundsRows(rows, 'grow', 5000)).toEqual([false, true, true]);
  });

  it('flags every row when the goal has no valid target yet (grow, target NaN)', () => {
    expect(checkpointOutOfBoundsRows([cp('a', 1000), cp('b', 2000)], 'grow', NaN)).toEqual([true, true]);
  });
});
