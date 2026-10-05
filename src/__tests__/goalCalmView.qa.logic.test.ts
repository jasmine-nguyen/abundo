// WHIT-749 QA — balanceGoalView's new outputs at their edges: pastDue at the local-midnight
// boundary and across a far-future / no-pay-cycle goal; currentAmount clamps (credit, overdraft);
// checkpointReached order + paydown direction + an empty ladder. Real engine, shared goalPace setup.
import { describe, it, expect } from '@jest/globals';
import { balanceGoalView } from '../context';
import { GOAL_CYCLE, goal, view } from './support/goalPace';

describe('pastDue edges (WHIT-749 QA)', () => {
  // [A1] the boundary is the device's local day: 23:59 on the target day is not past; 00:00 the next is.
  it('[A1] flips at local midnight after the target date, not before', () => {
    const g = goal({ target_date: '2026-07-11' });
    const at = (d: Date) => balanceGoalView({ goal: g, balance: 4000, payCycle: GOAL_CYCLE }, d).pastDue;
    expect(at(new Date(2026, 6, 11, 23, 59))).toBe(false);
    expect(at(new Date(2026, 6, 12, 0, 0))).toBe(true);
  });

  // [A2] pastDue doesn't depend on the pay cycle: a broken cycle (0 paydays) far from the date is not past due.
  it('[A2] a far-future goal with a zero-length pay cycle is not past due', () => {
    const v = balanceGoalView({ goal: goal({ target_date: '2027-12-01' }), balance: 4000, payCycle: { length: 0, last_pay_date: '2026-06-06' } }, new Date(2026, 6, 11));
    expect(v.paydaysLeft).toBe(0);
    expect(v.pastDue).toBe(false);
  });

  // [A3] an unknown balance doesn't hide past-due.
  it('[A3] pastDue is set even while the balance is unknown', () => {
    expect(view(goal({ target_date: '2026-06-01' }), null).pastDue).toBe(true);
  });
});

describe('currentAmount edges (WHIT-749 QA)', () => {
  // [A4] the "owed" figure uses the same clamp as the bar: a credit on a synced loan owes $0.
  it('[A4] a synced paydown in credit owes 0; an overdrawn grow account has saved 0', () => {
    expect(view(goal({ direction: 'paydown', target_amount: 0 }), 500).currentAmount).toBe(0);
    expect(view(goal(), -50).currentAmount).toBe(0);
  });

  // [A5] a manual goal ignores the live balance argument.
  it('[A5] a manual goal reads manual_balance, not the synced balance', () => {
    expect(view(goal({ account_id: null, manual_balance: 1234 }), 9999).currentAmount).toBe(1234);
  });
});

describe('checkpointReached edges (WHIT-749 QA)', () => {
  // [A6] paydown reaches AT/below the amount, in the goal's checkpoint order (slice 2 lists them by index).
  it('[A6] paydown: owed 12000 reaches 15000 and 12000, not 10000, in order', () => {
    const g = goal({ direction: 'paydown', target_amount: 0, checkpoints: [{ amount: 10000 }, { amount: 15000 }, { amount: 12000 }] });
    const v = view(g, -12000);
    expect(v.checkpointReached).toEqual([false, true, true]);
    expect(v.checkpointsReached).toBe(2);
  });

  // [A7] no ladder + known balance → an empty list, and the count stays null (card hides the line).
  it('[A7] no checkpoints gives [] and a null count', () => {
    const v = view(goal(), 4000);
    expect(v.checkpointReached).toEqual([]);
    expect(v.checkpointsReached).toBeNull();
  });

  // [A8] the per-checkpoint list is known even when the bar has no scale (slice 2 shows the ticks).
  it('[A8] a no-start paydown still flags each checkpoint', () => {
    const v = view(goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 9000, checkpoints: [{ amount: 9000 }, { amount: 5000 }] }));
    expect(v.progress).toBeNull();
    expect(v.checkpointReached).toEqual([true, false]);
  });
});
