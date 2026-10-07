// WHIT-817 — the goal page's "Next" milestone must be the closest unreached one even when the
// milestones were saved out of order (older goals, or written straight to the server). Rows come
// back in climb order and each keeps the reached mark of its own milestone. The pay-down case is
// fed by the REAL balanceGoalView, which marks reached in stored order (a synced debt account
// reports what's owed as a negative balance).
import { describe, it, expect } from '@jest/globals';
import { checkpointProgress } from '../checkpoints';
import { goal, view } from './support/goalPace';
import type { GoalCheckpoint } from '../api';

const m15: GoalCheckpoint = { id: 'm15', label: 'Under fifteen', amount: 15000 };
const m10: GoalCheckpoint = { id: 'm10', label: 'Under ten', amount: 10000 };
const m5: GoalCheckpoint = { id: 'm5', label: 'Under five', amount: 5000 };
const c1: GoalCheckpoint = { id: 'c1', label: 'Small buffer', amount: 2000 };
const c2: GoalCheckpoint = { id: 'c2', label: 'Big buffer', amount: 5000 };
const c3: GoalCheckpoint = { id: 'c3', label: 'Nearly there', amount: 7500 };

const summarise = (result: ReturnType<typeof checkpointProgress>) => ({
  rows: result.rows.map((r) => ({ id: r.checkpoint.id, reached: r.reached, toGo: r.toGo })),
  next: result.next?.checkpoint.id ?? null,
});

describe('checkpointProgress with milestones saved out of order', () => {
  it('pay-down saved 5k → 15k → 10k, $12,000 owed: next is "Under ten", not "Under five"', () => {
    const savedOrder = [m5, m15, m10];
    const realView = view(goal({ direction: 'paydown', target_amount: 0, checkpoints: savedOrder }), -12000);
    expect(realView.checkpointReached).toEqual([false, true, false]);

    expect(summarise(checkpointProgress(savedOrder, 'paydown', realView))).toEqual({
      rows: [
        { id: 'm15', reached: true, toGo: null },
        { id: 'm10', reached: false, toGo: 2000 },
        { id: 'm5', reached: false, toGo: 7000 },
      ],
      next: 'm10',
    });
  });

  it('grow saved 7.5k → 2k → 5k, $3,000 saved: next is "Big buffer" and reached marks follow their milestone', () => {
    const result = checkpointProgress([c3, c1, c2], 'grow', { currentAmount: 3000, checkpointReached: [false, true, false] });
    expect(summarise(result)).toEqual({
      rows: [
        { id: 'c1', reached: true, toGo: null },
        { id: 'c2', reached: false, toGo: 2000 },
        { id: 'c3', reached: false, toGo: 4500 },
      ],
      next: 'c2',
    });
  });
});
