// WHIT-748 QA — edge cases for balanceGoalView's dollar fields the proof test leaves open: the
// clamp at both ends of the bar, synced (negative-stored) loans, a paydown judged from its start
// but with no bar scale, the start-vs-baseline split for "Ahead by", and a sub-dollar gap.
// Same pinned calendar as goalDollars.logic.test: start Jun6 → target Aug15 = 70 days, Jul11 = 35
// elapsed → expected fill 0.5.
import { describe, it, expect } from '@jest/globals';
import { balanceGoalView, BalanceGoal } from '../context';

const CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const TODAY = new Date(2026, 6, 11); // Sat 11 Jul 2026
const START = { start_date: '2026-06-06', target_date: '2026-08-15' };

function goal(over: Partial<BalanceGoal> = {}): BalanceGoal {
  return { direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending', ...over };
}
const view = (g: BalanceGoal, balance: number | null = null) => balanceGoalView({ goal: g, balance, payCycle: CYCLE }, TODAY);

describe('balanceGoalView dollars — clamps match the bar (WHIT-748 QA)', () => {
  it('[A1] a goal past its target shows the full span, never more than the target', () => {
    const v = view(goal(), 12000);
    expect(v.progress).toBe(1);
    expect(v.movedAmount).toBeCloseTo(10000, 2);
    expect(v.spanAmount).toBe(10000);
  });

  it('[A2] a balance below the count-from amount shows $0 moved, not a negative', () => {
    const v = view(goal({ baseline: 2000 }), 1000);
    expect(v.progress).toBe(0);
    expect(v.movedAmount).toBe(0);
    expect(v.spanAmount).toBe(8000);
  });

  it('[A3] an overdrawn synced savings account shows $0 moved', () => {
    const v = view(goal(), -50);
    expect(v.movedAmount).toBe(0);
  });

  it('[A4] an unpolled synced goal keeps the span but has no moved dollars (so no "$X of $Y")', () => {
    const v = view(goal(), null);
    expect(v.progress).toBeNull();
    expect(v.movedAmount).toBeNull();
    expect(v.spanAmount).toBe(10000);
  });

  it('[A5] the dollars and the rounded % always agree', () => {
    for (const balance of [0, 1234.56, 4995, 5005, 9999.4]) {
      const v = view(goal({ baseline: 1000 }), balance);
      expect(Math.round((v.movedAmount! / v.spanAmount!) * 100)).toBe(Math.round(v.progress! * 100));
    }
  });
});

describe('balanceGoalView dollars — paydown (WHIT-748 QA)', () => {
  it('[A6] a synced loan (stored negative) with a baseline counts paid-down dollars from the baseline', () => {
    const v = view(goal({ direction: 'paydown', target_amount: 0, baseline: 20000, account_id: 'loan' }), -12000);
    expect(v.movedAmount).toBeCloseTo(8000, 2);
    expect(v.spanAmount).toBe(20000);
  });

  it('[A7] a synced loan ahead of schedule gets the ahead-by dollars from its start', () => {
    const v = view(goal({ direction: 'paydown', target_amount: 0, baseline: 20000, account_id: 'loan', ...START, start_balance: -20000 }), -8000);
    // owed 8000 → actual (20000 − 8000)/20000 = 0.6 vs 0.5 → 0.1 × 20000 = 2000.
    expect(v.status).toBe('ahead');
    expect(v.aheadBy).toBeCloseTo(2000, 2);
  });

  it('[A8] a paydown with a start but no baseline is judged (pill) yet has no dollars line', () => {
    const v = view(goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 8000, ...START, start_balance: 20000 }));
    expect(v.movedAmount).toBeNull();
    expect(v.spanAmount).toBeNull();
    expect(v.status).toBe('ahead');
    expect(v.aheadBy).toBeCloseTo(2000, 2);
  });
});

describe('balanceGoalView ahead-by — measured from the start, not the bar (WHIT-748 QA)', () => {
  it('[A9] "ahead by" uses start_balance → target, even when the bar counts from $0', () => {
    // Bar: 8000 of 10000. Pace: from start 2000 → actual 0.75 vs 0.5 → 0.25 × 8000 = 2000 (not × 10000).
    const v = view(goal({ ...START, start_balance: 2000 }), 8000);
    expect(v.movedAmount).toBeCloseTo(8000, 2);
    expect(v.status).toBe('ahead');
    expect(v.aheadBy).toBeCloseTo(2000, 2);
  });

  it('[A10] ahead-by is always positive and never more than what is left to the target', () => {
    const v = view(goal({ ...START, start_balance: 0 }), 10000);
    // actual 1 vs expected 0.5 → 0.5 × 10000 = 5000.
    expect(v.aheadBy).toBeCloseTo(5000, 2);
    const over = view(goal({ ...START, start_balance: 0 }), 50000);
    expect(over.aheadBy).toBeCloseTo(5000, 2); // actual clamps at 1
  });

  it('[A11] a tiny goal ahead by under a dollar still reports the sub-dollar gap', () => {
    // target 2, start 0, balance 1.5 → actual 0.75 vs 0.5 → 0.25 × 2 = 0.5.
    const v = view(goal({ target_amount: 2, ...START, start_balance: 0 }), 1.5);
    expect(v.status).toBe('ahead');
    expect(v.aheadBy).toBeCloseTo(0.5, 5);
  });
});
