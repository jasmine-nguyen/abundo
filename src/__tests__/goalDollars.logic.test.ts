// WHIT-748 — balanceGoalView's dollar fields: movedAmount / spanAmount (the "$X of $Y" line, on the
// SAME scale as the % and the bar) and aheadBy (the "Ahead by $X" pill, dollars past the
// straight-line schedule). Expecteds hand-computed in the comments. Runner pins TZ=Australia/Melbourne.
import { describe, it, expect } from '@jest/globals';
import { balanceGoalView, BalanceGoal } from '../context';

// Paydays …Jun6, Jul4, Jul18, Aug1, Aug15. Start Jun6 → target Aug15 = 70 days; Jul11 = 35 elapsed
// → expected fill 0.5 (on-track band [0.45, 0.55]).
const CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const TODAY = new Date(2026, 6, 11); // Sat 11 Jul 2026

function goal(over: Partial<BalanceGoal> = {}): BalanceGoal {
  return { direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending', ...over };
}
const debt = (over: Partial<BalanceGoal> = {}) =>
  goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 12000, manual_as_of: '2026-07-01', ...over });
const view = (g: BalanceGoal, balance: number | null = null) => balanceGoalView({ goal: g, balance, payCycle: CYCLE }, TODAY);

describe('balanceGoalView — dollars moved, span and ahead-by (WHIT-748)', () => {
  it('gives the "$X of $Y" dollars on the same scale as the %, and the ahead-by gap only when ahead', () => {
    // grow, no baseline: 4000 of 10000 (40%).
    const grow = view(goal(), 4000);
    expect(grow.movedAmount).toBeCloseTo(4000, 2);
    expect(grow.spanAmount).toBe(10000);

    // grow counting from a baseline: (4000 − 2000) of (10000 − 2000) — agrees with the 25%.
    const fromBaseline = view(goal({ baseline: 2000 }), 4000);
    expect(fromBaseline.movedAmount).toBeCloseTo(2000, 2);
    expect(fromBaseline.spanAmount).toBe(8000);

    // paydown from 20000 owed, now 12000: 8000 paid down of 20000.
    const paydown = view(debt({ baseline: 20000 }));
    expect(paydown.movedAmount).toBeCloseTo(8000, 2);
    expect(paydown.spanAmount).toBe(20000);

    // paydown with no baseline has no bar scale → no dollars line.
    const noScale = view(debt());
    expect(noScale.movedAmount).toBeNull();
    expect(noScale.spanAmount).toBeNull();

    // unknown balance → nothing moved, no ahead-by.
    const unknown = view(goal({ start_date: '2026-06-06', start_balance: 2000 }), null);
    expect(unknown.movedAmount).toBeNull();
    expect(unknown.aheadBy).toBeNull();

    // grow start 2000 → actual (8000 − 2000)/8000 = 0.75 vs expected 0.5 → ahead by 0.25 × 8000 = 2000.
    const ahead = view(goal({ start_date: '2026-06-06', start_balance: 2000 }), 8000);
    expect(ahead.status).toBe('ahead');
    expect(ahead.aheadBy).toBeCloseTo(2000, 2);

    // paydown start 20000 owed, now 8000 → 0.6 vs 0.5 → ahead by 0.1 × 20000 = 2000.
    const debtAhead = view(debt({ baseline: 20000, start_date: '2026-06-06', start_balance: 20000, manual_balance: 8000 }));
    expect(debtAhead.status).toBe('ahead');
    expect(debtAhead.aheadBy).toBeCloseTo(2000, 2);

    // on track (0.5) and behind (0.25) → no ahead-by.
    const onTrack = view(goal({ start_date: '2026-06-06', start_balance: 2000 }), 6000);
    expect(onTrack.status).toBe('on_track');
    expect(onTrack.aheadBy).toBeNull();
    const behind = view(goal({ start_date: '2026-06-06', start_balance: 2000 }), 4000);
    expect(behind.status).toBe('behind');
    expect(behind.aheadBy).toBeNull();
  });
});
