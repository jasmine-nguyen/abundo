// WHIT-232 / WHIT-262 — balanceGoalView + paydaysUntil: the pure goal pace engine. Progress %
// and per-payday pace for grow (savings) and paydown (debt), source-aware sign normalisation,
// every denominator guarded. Status (ahead/on_track/behind) measured from the immutable start.
// Expecteds are computed by hand in the comments so a revert fails. Runner pins
// TZ=Australia/Melbourne (package.json).
import { describe, it, expect } from '@jest/globals';
import { paydaysUntil, balanceGoalView, GOAL_PACE_TOLERANCE, BalanceGoal } from '../context';

// A fortnightly cycle whose paydays land Jun6, Jun20, Jul4, Jul18, Aug1, Aug15, Aug29, ...
const CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const TODAY = new Date(2026, 6, 11); // Sat 11 Jul 2026 (Melbourne local midnight)

function goal(over: Partial<BalanceGoal> = {}): BalanceGoal {
  return {
    direction: 'grow', target_amount: 10000, target_date: '2026-08-15',
    account_id: 'up-spending', ...over,
  };
}

// --- paydaysUntil ----------------------------------------------------------

describe('paydaysUntil', () => {
  it('counts the payday landing exactly ON the target (phase-aware, not floor(days/len))', () => {
    // (Jul11, Jul18]: only Jul18 (a payday). Naive floor(7/14) would say 0.
    const n = paydaysUntil(CYCLE, '2026-07-18', TODAY);
    expect(n).toBe(1);
    expect(n).not.toBe(0); // fail-on-revert vs the naive floor(daysUntil/length)
  });

  it('excludes a payday one day past the target', () => {
    // (Jul11, Jul17]: no payday (Jul18 is outside). floor(41/14)-floor(35/14)=2-2.
    expect(paydaysUntil(CYCLE, '2026-07-17', TODAY)).toBe(0);
  });

  it("excludes today's own payday (strictly after today)", () => {
    // today = Jul4 (a payday); (Jul4, Jul18] -> only Jul18. floor(42/14)-floor(28/14)=3-2.
    expect(paydaysUntil(CYCLE, '2026-07-18', new Date(2026, 6, 4))).toBe(1);
  });

  it('handles a last_pay_date in the FUTURE (paydays fill backward, n<0)', () => {
    // pay=Aug1; (Jul11, Sep1] -> Jul18, Aug1, Aug15, Aug29 = 4. floor(31/14)-floor(-21/14)=2-(-2).
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-08-01' }, '2026-09-01', TODAY)).toBe(4);
  });

  it('is daylight-saving immune across the Melbourne spring-forward (Oct 4 2026)', () => {
    // pay=Sep27, today=Sep27, target=Oct11 spans the DST change; (Sep27, Oct11] -> Oct11 only.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-09-27' }, '2026-10-11', new Date(2026, 8, 27))).toBe(1);
  });

  it('returns 0 for a non-positive length or an unparseable date (no NaN)', () => {
    expect(paydaysUntil({ length: 0, last_pay_date: '2026-06-06' }, '2026-08-15', TODAY)).toBe(0);
    expect(paydaysUntil(CYCLE, 'not-a-date', TODAY)).toBe(0);
  });
});

// --- balanceGoalView: grow -------------------------------------------------

describe('balanceGoalView — grow', () => {
  it('progress = balance/target, pace = remaining/paydaysLeft', () => {
    // target_date Aug15 -> paydaysLeft 3 (Jul18, Aug1, Aug15). remaining 6000 / 3 = 2000.
    const v = balanceGoalView({ goal: goal(), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.paydaysLeft).toBe(3);
    expect(v.progress).toBeCloseTo(0.4, 10);
    expect(v.pacePerPayday).toBe(2000);
    expect(v.status).toBeNull();
  });

  it('measures from the baseline when present', () => {
    // (4000-2000)/(10000-2000) = 0.25.
    const v = balanceGoalView({ goal: goal({ baseline: 2000 }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeCloseTo(0.25, 10);
  });

  it('clamps an overdrawn synced balance to 0 progress (not Math.abs)', () => {
    // balance -50 -> current 0 -> progress 0, NOT abs(-50)/10000 = 0.005.
    const v = balanceGoalView({ goal: goal(), balance: -50, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(0);
  });

  it('a met goal caps at 1 with 0 pace, never negative', () => {
    const v = balanceGoalView({ goal: goal({ target_amount: 20000 }), balance: 25000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(1);
    expect(v.pacePerPayday).toBe(0);
  });

  it('grow target == baseline is a null progress, not NaN', () => {
    const v = balanceGoalView({ goal: goal({ baseline: 10000, target_amount: 10000 }), balance: 5000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeNull();
  });
});

// --- balanceGoalView: paydown ----------------------------------------------

describe('balanceGoalView — paydown', () => {
  const debt = (over: Partial<BalanceGoal> = {}) =>
    goal({ direction: 'paydown', target_amount: 0, baseline: 20000, target_date: '2026-08-15', ...over });

  it('progress = paid-off share, synced negative balance normalised to owed', () => {
    // synced -12000 -> owed 12000 -> (20000-12000)/20000 = 0.4; remaining 12000 / 3 = 4000.
    const v = balanceGoalView({ goal: debt(), balance: -12000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeCloseTo(0.4, 10);
    expect(v.pacePerPayday).toBe(4000);
  });

  it('a synced loan genuinely in credit reads as met (owed 0), not phantom debt', () => {
    // balance +200 -> owed max(0,-200)=0 -> progress 1, pace 0. Math.abs would give owed 200.
    const v = balanceGoalView({ goal: debt(), balance: 200, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(1);
    expect(v.pacePerPayday).toBe(0);
  });

  it('a manual debt (positive owed) gives the same result as the synced negative', () => {
    const synced = balanceGoalView({ goal: debt(), balance: -12000, payCycle: CYCLE }, TODAY);
    const manual = balanceGoalView(
      { goal: debt({ account_id: null, manual_balance: 12000, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE },
      TODAY);
    expect(manual.progress).toBeCloseTo(synced.progress!, 10);
    expect(manual.pacePerPayday).toBe(synced.pacePerPayday);
  });

  it('without a baseline start reference, progress is null but pace still computes', () => {
    const v = balanceGoalView(
      { goal: debt({ baseline: null, account_id: null, manual_balance: 8000, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE },
      TODAY);
    expect(v.progress).toBeNull();
    expect(v.pacePerPayday).toBe(8000 / 3); // remaining 8000 over 3 paydays
  });

  it('baseline == target is a null progress, not NaN', () => {
    const v = balanceGoalView(
      { goal: debt({ baseline: 5000, target_amount: 5000, account_id: null, manual_balance: 3000, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE },
      TODAY);
    expect(v.progress).toBeNull();
  });
});

// --- edges: overdue, unpolled, no-date, status, NaN sweep ------------------

describe('balanceGoalView — edges', () => {
  it('an overdue goal (0 paydays left) makes the whole remaining due now', () => {
    const v = balanceGoalView({ goal: goal({ target_date: '2026-06-01' }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.paydaysLeft).toBe(0);
    expect(v.pacePerPayday).toBe(6000); // remaining, not remaining/0
  });

  it('a synced goal not yet polled has null progress + pace but still counts paydays', () => {
    const v = balanceGoalView({ goal: goal(), balance: null, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeNull();
    expect(v.pacePerPayday).toBeNull();
    expect(v.paydaysLeft).toBe(3);
  });

  it('status stays null without the start fields (grow + paydown)', () => {
    const cases = [
      balanceGoalView({ goal: goal(), balance: 4000, payCycle: CYCLE }, TODAY),
      balanceGoalView({ goal: goal({ direction: 'paydown', target_amount: 0, baseline: 20000 }), balance: -12000, payCycle: CYCLE }, TODAY),
    ];
    for (const v of cases) expect(v.status).toBeNull();
  });

  it('never emits NaN / Infinity or a bogus status across degenerate inputs', () => {
    const degenerate: { goal: BalanceGoal; balance: number | null }[] = [
      { goal: goal({ baseline: 10000, target_amount: 10000 }), balance: 5000 },
      { goal: goal({ direction: 'paydown', target_amount: 0, baseline: 0, account_id: null, manual_balance: 0, manual_as_of: '2026-07-01' }), balance: null },
      { goal: goal({ target_date: '2026-06-01' }), balance: -99999 },
      { goal: goal(), balance: null },
      // start-bearing degenerates: unparseable date, zero span, start at target.
      { goal: goal({ start_date: 'not-a-date', start_balance: 2000 }), balance: 4000 },
      { goal: goal({ start_date: '2026-08-15', start_balance: 2000 }), balance: 4000 },
      { goal: goal({ start_date: '2026-06-06', start_balance: 10000 }), balance: 10000 },
    ];
    for (const d of degenerate) {
      const v = balanceGoalView({ goal: d.goal, balance: d.balance, payCycle: CYCLE }, TODAY);
      expect(v.progress === null || (Number.isFinite(v.progress) && v.progress >= 0 && v.progress <= 1)).toBe(true);
      expect(v.pacePerPayday === null || (Number.isFinite(v.pacePerPayday) && v.pacePerPayday >= 0)).toBe(true);
      expect(Number.isFinite(v.paydaysLeft) && v.paydaysLeft >= 0).toBe(true);
      expect(v.status === null || ['ahead', 'on_track', 'behind'].includes(v.status)).toBe(true);
    }
  });
});

// --- WHIT-252: the immutable start fields are carried through ------------------
describe('balanceGoalView — start_date / start_balance (WHIT-252)', () => {
  it('carries the start fields without perturbing the existing progress', () => {
    const withStart = goal({ start_date: '2026-06-06', start_balance: 2000 });
    const v = balanceGoalView({ goal: withStart, balance: 4000, payCycle: CYCLE }, TODAY);
    // progress still counts from baseline (0 here): 40% at 4000/10000, unchanged by the start.
    expect(v.progress).toBeCloseTo(0.4, 5);
  });
});

// --- WHIT-262: ahead / on-track / behind from the immutable start -------------
// Start Jun6 -> target Aug15 = 70 days; TODAY Jul11 = 35 elapsed -> expected fill 0.5.
// Tolerance 0.05 -> on-track band [0.45, 0.55]. All fractions hand-computed so a revert fails.
describe('balanceGoalView — status (WHIT-262)', () => {
  const START = { start_date: '2026-06-06', start_balance: 2000 }; // grow: startN 2000, denom 8000
  const paced = (over: Partial<BalanceGoal> = {}) => goal({ ...START, ...over });

  it('exports a 0.05 tolerance (change is a conscious test update)', () => {
    expect(GOAL_PACE_TOLERANCE).toBe(0.05);
  });

  describe('grow (synced)', () => {
    it('behind when actual < expected − tol (0.25 vs 0.5)', () => {
      // (4000−2000)/8000 = 0.25 <= 0.45.
      const v = balanceGoalView({ goal: paced(), balance: 4000, payCycle: CYCLE }, TODAY);
      expect(v.status).toBe('behind');
    });
    it('on_track inside the band (0.5 vs 0.5)', () => {
      // (6000−2000)/8000 = 0.5.
      const v = balanceGoalView({ goal: paced(), balance: 6000, payCycle: CYCLE }, TODAY);
      expect(v.status).toBe('on_track');
    });
    it('ahead when actual > expected + tol (0.75 vs 0.5)', () => {
      // (8000−2000)/8000 = 0.75 >= 0.55.
      const v = balanceGoalView({ goal: paced(), balance: 8000, payCycle: CYCLE }, TODAY);
      expect(v.status).toBe('ahead');
    });
  });

  it('grow (manual) matches the synced-signed equivalent', () => {
    const synced = balanceGoalView({ goal: paced(), balance: 4000, payCycle: CYCLE }, TODAY);
    const manual = balanceGoalView(
      { goal: paced({ account_id: null, manual_balance: 4000, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE },
      TODAY);
    expect(manual.status).toBe(synced.status);
    expect(manual.status).toBe('behind');
  });

  describe('paydown (signed start + balance)', () => {
    // start owing 20000 -> start_balance −20000 -> startN 20000; target 0 -> denom 20000.
    const debt = (over: Partial<BalanceGoal> = {}) =>
      goal({ direction: 'paydown', target_amount: 0, baseline: 20000, start_date: '2026-06-06', start_balance: -20000, ...over });

    it('behind: owe 12000 -> 0.4 fill', () => {
      // (20000−12000)/20000 = 0.4 <= 0.45.
      const v = balanceGoalView({ goal: debt(), balance: -12000, payCycle: CYCLE }, TODAY);
      expect(v.status).toBe('behind');
    });
    it('on_track: owe 10000 -> 0.5 fill', () => {
      const v = balanceGoalView({ goal: debt(), balance: -10000, payCycle: CYCLE }, TODAY);
      expect(v.status).toBe('on_track');
    });
    it('ahead: owe 8000 -> 0.6 fill', () => {
      const v = balanceGoalView({ goal: debt(), balance: -8000, payCycle: CYCLE }, TODAY);
      expect(v.status).toBe('ahead');
    });
    it('manual debt (as-entered positive start) matches the synced-signed equivalent', () => {
      const synced = balanceGoalView({ goal: debt(), balance: -12000, payCycle: CYCLE }, TODAY);
      const manual = balanceGoalView(
        { goal: debt({ account_id: null, start_balance: 20000, manual_balance: 12000, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE },
        TODAY);
      expect(manual.status).toBe(synced.status);
      expect(manual.status).toBe('behind');
    });
  });

  describe('the tolerance boundary is inclusive on both edges', () => {
    it('exactly expected − tol reads behind (0.45)', () => {
      // (5600−2000)/8000 = 0.45; behind uses <=.
      expect(balanceGoalView({ goal: paced(), balance: 5600, payCycle: CYCLE }, TODAY).status).toBe('behind');
    });
    it('exactly expected + tol reads ahead (0.55)', () => {
      // (6400−2000)/8000 = 0.55; ahead uses >=.
      expect(balanceGoalView({ goal: paced(), balance: 6400, payCycle: CYCLE }, TODAY).status).toBe('ahead');
    });
  });

  describe('null fallbacks (no honest label)', () => {
    it('missing start_date', () => {
      expect(balanceGoalView({ goal: goal({ start_balance: 2000 }), balance: 4000, payCycle: CYCLE }, TODAY).status).toBeNull();
    });
    it('missing start_balance', () => {
      expect(balanceGoalView({ goal: goal({ start_date: '2026-06-06' }), balance: 4000, payCycle: CYCLE }, TODAY).status).toBeNull();
    });
    it('unknown (unpolled) balance', () => {
      expect(balanceGoalView({ goal: paced(), balance: null, payCycle: CYCLE }, TODAY).status).toBeNull();
    });
    it('start already at/above the target (grow denom 0)', () => {
      expect(balanceGoalView({ goal: paced({ start_balance: 10000 }), balance: 9000, payCycle: CYCLE }, TODAY).status).toBeNull();
    });
    it('zero-duration span (start_date == target_date)', () => {
      expect(balanceGoalView({ goal: paced({ start_date: '2026-08-15' }), balance: 6000, payCycle: CYCLE }, TODAY).status).toBeNull();
    });
    it('target before start (negative span)', () => {
      expect(balanceGoalView({ goal: paced({ start_date: '2026-09-01' }), balance: 6000, payCycle: CYCLE }, TODAY).status).toBeNull();
    });
    it('unparseable start_date', () => {
      expect(balanceGoalView({ goal: paced({ start_date: 'not-a-date' }), balance: 6000, payCycle: CYCLE }, TODAY).status).toBeNull();
    });
  });

  it('today before start_date reads ahead (expected 0), never crashes', () => {
    // start Aug1 (after today), target Sep1: elapsed −21 clamps to 0 -> expected 0; actual 0.25 -> ahead.
    const v = balanceGoalView(
      { goal: paced({ start_date: '2026-08-01', target_date: '2026-09-01' }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.status).toBe('ahead');
  });

  it('near the deadline (expected > 0.95) a met goal reads on_track, not ahead (documented ceiling)', () => {
    // start Jun6 -> target Jul12 = 36 days; 35 elapsed -> expected 0.972. A full 1.0 fill sits
    // inside [0.922, 1.022], so ahead is unreachable in the final 5% by design.
    const v = balanceGoalView({ goal: paced({ target_date: '2026-07-12' }), balance: 10000, payCycle: CYCLE }, TODAY);
    expect(v.status).toBe('on_track');
  });
});

// WHIT-232 adversarial gaps — more paydaysUntil phases/lengths + autumn DST + leap day; the full
// direction×source sign matrix (incl. grow-manual and the account_id+manual_balance XOR); progress
// clamps below 0 / defensive baselines; NaN/Infinity guards; garbage target_date. Hand-counted.
describe('paydaysUntil — phases/lengths/boundaries', () => {
  const W = { length: 7, last_pay_date: '2026-07-01' };  // weekly: Jul1,8,15,22,29,Aug5...
  const M = { length: 30, last_pay_date: '2026-01-15' }; // ~monthly

  it('[A20] weekly (len 7): (Jul11, Aug1] -> Jul15,22,29 = 3', () => {
    expect(paydaysUntil(W, '2026-08-01', TODAY)).toBe(3);
  });

  it('[A21] weekly far-future target one year out -> 51 (large count stays exact)', () => {
    // pay Jul1; paydays at day 0,7,..,364; window (day10, day365] -> n=2..52 = 51.
    expect(paydaysUntil(W, '2027-07-01', TODAY)).toBe(51);
  });

  it('[A22] ~monthly (len 30): (Jul11, Aug15] -> 2 paydays (Jul14, Aug13)', () => {
    expect(paydaysUntil(M, '2026-08-15', TODAY)).toBe(2);
  });

  it('[A23] target BEFORE last_pay_date -> 0 (no negative count)', () => {
    expect(paydaysUntil(W, '2026-06-20', TODAY)).toBe(0);
  });

  it('[A24] target == today, and today IS a payday -> 0 (half-open excludes both ends here)', () => {
    // today = Jul8 (a weekly payday); window (Jul8, Jul8] is empty.
    expect(paydaysUntil(W, '2026-07-08', new Date(2026, 6, 8))).toBe(0);
  });

  it('[A25] today far BEFORE last_pay_date (backward-filled paydays) -> 17', () => {
    // pay Aug1 len14; (Jan1, Aug15] enumerates 17 fortnightly paydays.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-08-01' }, '2026-08-15', new Date(2026, 0, 1))).toBe(17);
  });

  it('[A26] DST autumn fall-back (Melbourne, Sun 5 Apr 2026) does not shift the count', () => {
    // pay=today=Mar22, target=Apr19 spans the fall-back; (Mar22, Apr19] -> Apr5, Apr19 = 2.
    expect(paydaysUntil({ length: 14, last_pay_date: '2026-03-22' }, '2026-04-19', new Date(2026, 2, 22))).toBe(2);
  });

  it('[A27] leap-day target (29 Feb 2028) counts correctly', () => {
    // pay Feb1 2028 len14 -> Feb1,15,29; (Feb1, Feb29] -> Feb15, Feb29 = 2.
    expect(paydaysUntil({ length: 14, last_pay_date: '2028-02-01' }, '2028-02-29', new Date(2028, 1, 1))).toBe(2);
  });

  it('[A28] leap-day last_pay_date (29 Feb 2028) as the anchor counts correctly', () => {
    // pay=today=Feb29; (Feb29, Mar14] -> Mar14 = 1.
    expect(paydaysUntil({ length: 14, last_pay_date: '2028-02-29' }, '2028-03-14', new Date(2028, 1, 29))).toBe(1);
  });
});

describe('balanceGoalView — sign/source matrix', () => {
  it('[A30] grow-MANUAL: reads goal.manual_balance (not the null balance input)', () => {
    // account_id null -> manual source; manual_balance 4000 / target 10000 = 0.4.
    const v = balanceGoalView(
      { goal: goal({ account_id: null, manual_balance: 4000, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE },
      TODAY);
    expect(v.progress).toBeCloseTo(0.4, 10);
    expect(v.pacePerPayday).toBe(2000); // 6000 / 3
  });

  it('[A31] account_id AND manual_balance both set (XOR violation): synced WINS, reads balance', () => {
    // manual_balance 999 must be IGNORED because account_id is present. progress uses 4000.
    const v = balanceGoalView({ goal: goal({ manual_balance: 999 }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeCloseTo(0.4, 10); // 4000/10000, NOT 999/10000 = 0.0999
  });

  it('[A32] synced GROW balance exactly 0 -> valid 0 savings (progress 0, a number)', () => {
    const v = balanceGoalView({ goal: goal(), balance: 0, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(0);
    expect(v.pacePerPayday).toBe(10000 / 3);
  });

  it('[A33] synced PAYDOWN balance exactly 0 -> owed 0 -> met (progress 1, pace 0)', () => {
    const v = balanceGoalView(
      { goal: goal({ direction: 'paydown', target_amount: 0, baseline: 20000 }), balance: 0, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(1);
    expect(v.pacePerPayday).toBe(0);
  });

  it('[A34] manual_balance exactly 0 (grow) -> progress 0, (paydown) -> met 1', () => {
    const grow = balanceGoalView(
      { goal: goal({ account_id: null, manual_balance: 0, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE }, TODAY);
    expect(grow.progress).toBe(0);
    const pay = balanceGoalView(
      { goal: goal({ direction: 'paydown', target_amount: 0, baseline: 20000, account_id: null, manual_balance: 0, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE }, TODAY);
    expect(pay.progress).toBe(1);
  });

  it('[A35] NaN / Infinity synced balance is guarded to null (unknown), paydays still count', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = balanceGoalView({ goal: goal(), balance: bad, payCycle: CYCLE }, TODAY);
      expect(v.progress).toBeNull();
      expect(v.pacePerPayday).toBeNull();
      expect(v.paydaysLeft).toBe(3);
    }
  });

  it('[A36] NaN manual_balance is guarded to null (unknown)', () => {
    const v = balanceGoalView(
      { goal: goal({ account_id: null, manual_balance: NaN, manual_as_of: '2026-07-01' }), balance: null, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeNull();
    expect(v.pacePerPayday).toBeNull();
  });
});

describe('balanceGoalView — progress clamps', () => {
  it('[A40] paydown debt GREW past baseline (owed > baseline) clamps to 0, never negative', () => {
    // synced -25000 -> owed 25000; (20000-25000)/20000 = -0.25 -> clamp 0. pace = 25000/3.
    const v = balanceGoalView(
      { goal: goal({ direction: 'paydown', target_amount: 0, baseline: 20000 }), balance: -25000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(0);
    expect(v.pacePerPayday).toBeCloseTo(25000 / 3, 6);
  });

  it('[A41] grow current == baseline is progress 0 (a number), not null', () => {
    const v = balanceGoalView({ goal: goal({ baseline: 2000 }), balance: 2000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBe(0);
  });

  it('[A42] defensive negative baseline (grow) still yields finite in-range progress', () => {
    // baseline -1000, target 10000, bal 4000 -> (4000+1000)/11000 = 0.4545..., finite.
    const v = balanceGoalView({ goal: goal({ baseline: -1000 }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.progress).toBeCloseTo(5000 / 11000, 10);
    expect(Number.isFinite(v.progress as number)).toBe(true);
  });
});

describe('balanceGoalView — pace/paydaysLeft', () => {
  it('[A43] garbage target_date -> paydaysLeft 0 -> pace = whole remaining (no crash/NaN)', () => {
    const v = balanceGoalView({ goal: goal({ target_date: 'not-a-date' }), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.paydaysLeft).toBe(0);
    expect(v.pacePerPayday).toBe(6000); // remaining, not remaining/0
    expect(Number.isFinite(v.pacePerPayday as number)).toBe(true);
  });
});

// ===== WHIT-262 (folded from balanceGoalStatus.gaps.logic.test.ts) — balanceGoalView.status
// ADVERSARIAL GAPS (independent of the status describe block above; do not duplicate those).
// Hunts the corners left open: start_balance === 0 (falsy but a REAL start), the progress-bar vs
// status DIVERGENCE the interface comment promises, a goal MET mid-timeline, a fill driven
// negative, paydown denom guards for a zero / in-credit synced start, NON-FINITE start_balance,
// and the elapsed==0 / elapsed==total day boundaries. CYCLE, TODAY and goal() are reused from the
// survivor above (identical values; the gaps file's own duplicates are dropped). statusOf is
// gaps-only and kept at module level.
const statusOf = (g: BalanceGoal, balance: number | null) =>
  balanceGoalView({ goal: g, balance, payCycle: CYCLE }, TODAY).status;

// --- start_balance === 0 is a REAL anchor, not "missing" -----------------------
describe('grow start_balance === 0 (falsy but present)', () => {
  const g = goal({ start_date: '2026-06-06', start_balance: 0 }); // startN 0 -> denom = target 10000

  it('is judged, not nulled (0 must survive the null/finite guard)', () => {
    // current 5000 -> (5000-0)/10000 = 0.5 == expected 0.5 -> on_track.
    expect(statusOf(g, 5000)).toBe('on_track');
  });
  it('the 0-start really drives the denominator (behind below the band)', () => {
    // 2000/10000 = 0.2 <= 0.45 -> behind. Guards a `!goal.start_balance` truthiness regression.
    expect(statusOf(g, 2000)).toBe('behind');
  });
});

// --- progress bar vs status DIVERGENCE (by design; see BalanceGoalView comment) -
it('bar % and status label diverge when baseline != start_balance (bar 0.85, status behind)', () => {
  // baseline 0 (default) drives the BAR: 8500/10000 = 0.85.
  // start_balance 8000 drives STATUS: (8500-8000)/(10000-8000) = 0.25 <= 0.45 -> behind.
  const g = goal({ start_date: '2026-06-06', start_balance: 8000 });
  const v = balanceGoalView({ goal: g, balance: 8500, payCycle: CYCLE }, TODAY);
  expect(v.progress).toBeCloseTo(0.85, 10);
  expect(v.status).toBe('behind');
});

// --- clamp corners of actualFrac ----------------------------------------------
it('a goal MET mid-timeline reads ahead (fill clamps to 1.0 vs expected 0.5), not on_track', () => {
  // start_balance 2000, current 10000 -> (10000-2000)/8000 = 1.0 >= 0.55 -> ahead.
  const g = goal({ start_date: '2026-06-06', start_balance: 2000 });
  const v = balanceGoalView({ goal: g, balance: 10000, payCycle: CYCLE }, TODAY);
  expect(v.progress).toBe(1);
  expect(v.status).toBe('ahead');
});

it('grow that LOST money (current below start) clamps the fill to 0 -> behind, never negative', () => {
  // start_balance 4000, current 3000 -> (3000-4000)/6000 = -0.167 clamp 0 <= 0.45 -> behind.
  expect(statusOf(goal({ start_date: '2026-06-06', start_balance: 4000 }), 3000)).toBe('behind');
});

// --- paydown synced denom guard: a start already clear / in credit -------------
describe('paydown synced start with nothing to measure -> null', () => {
  const debt = (over: Partial<BalanceGoal> = {}) =>
    goal({ direction: 'paydown', target_amount: 0, baseline: 20000, start_date: '2026-06-06', ...over });

  it('synced start_balance 0 (owed nothing at start) -> startN 0, denom 0 -> null', () => {
    expect(statusOf(debt({ start_balance: 0 }), -5000)).toBeNull();
  });
  it('synced start already IN CREDIT (positive signed start) -> startN clamps 0, denom 0 -> null', () => {
    // start_balance +5000 (account in credit) -> normalise max(0,-5000)=0 -> denom 0-0=0 -> null.
    expect(statusOf(debt({ start_balance: 5000 }), -5000)).toBeNull();
  });
});

// --- non-finite start_balance -> null (never a NaN/Infinity-driven label) -------
it('non-finite start_balance (NaN / +Inf / -Inf) -> null, never a bogus label', () => {
  // -Infinity is the load-bearing case: grow normalise max(0,-Inf)=0 -> denom = target > 0, so
  // WITHOUT the explicit finite guard it would compute a real fill (0.6) and read 'ahead'. The
  // guard must reject it up front.
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(statusOf(goal({ start_date: '2026-06-06', start_balance: bad }), 6000)).toBeNull();
  }
});

// --- day boundaries: elapsed == 0 and elapsed == total -------------------------
it('today exactly ON start_date (elapsed 0 -> expected 0): a filled goal reads ahead, no crash', () => {
  // start Jul11 == today, target Aug15 (35d span > 0). elapsed 0 -> expected 0.
  // (6000-2000)/8000 = 0.5 >= 0.05 -> ahead.
  expect(statusOf(goal({ start_date: '2026-07-11', start_balance: 2000 }), 6000)).toBe('ahead');
});

describe('today exactly ON target_date (elapsed == total -> expected 1.0)', () => {
  // start Jun6 -> target Jul11 == today: total 35, elapsed 35 -> expected exactly 1.0.
  const g = goal({ start_date: '2026-06-06', target_date: '2026-07-11', start_balance: 2000 });
  it('a met goal reads on_track (1.0 within the band of 1.0), not behind', () => {
    expect(statusOf(g, 10000)).toBe('on_track'); // fill (10000-2000)/8000 = 1.0
  });
  it('an unmet goal reads behind on the deadline', () => {
    expect(statusOf(g, 6000)).toBe('behind'); // fill 0.5 <= 0.95
  });
});

// --- paydown WITHOUT a baseline: no bar, but still a status label --------------
it('paydown with start fields but NO baseline: progress null (no bar) yet status is judged', () => {
  // progress needs a baseline for paydown (stays null); status reads start_balance instead.
  // synced start owe 20000 (-20000), owe 12000 now -> (20000-12000)/20000 = 0.4 <= 0.45 -> behind.
  const g = goal({ direction: 'paydown', target_amount: 0, start_date: '2026-06-06', start_balance: -20000 });
  const v = balanceGoalView({ goal: g, balance: -12000, payCycle: CYCLE }, TODAY);
  expect(v.progress).toBeNull();
  expect(v.status).toBe('behind');
});

// --- WHIT-478: checkpoints reached-count ------------------------------------
// How many checkpoint amounts the CURRENT normalised balance has passed. grow reaches AT/above
// the amount, paydown AT/below. Uses the same normalised `current` as the bar, so the count can
// never disagree with it. `total` is 0 with no ladder; `reached` is null when the balance is
// unknown (a synced goal not yet polled).
describe('balanceGoalView — checkpoints reached-count', () => {
  const CPS = (...amounts: number[]) => amounts.map((amount) => ({ amount }));

  it('grow: counts the rungs at or below the balance (>=), boundary counts as reached', () => {
    // synced grow, balance 4000, rungs 2000/4000/6000/8000 → 2000 and 4000 reached (4000 is AT).
    const g = goal({ checkpoints: CPS(2000, 4000, 6000, 8000) });
    const v = balanceGoalView({ goal: g, balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsReached).toBe(2);
    expect(v.checkpointsTotal).toBe(4);
  });

  it('grow: a rung one dollar above the balance is NOT reached', () => {
    const g = goal({ checkpoints: CPS(4000) });
    expect(balanceGoalView({ goal: g, balance: 3999, payCycle: CYCLE }, TODAY).checkpointsReached).toBe(0);
  });

  it('paydown: counts the rungs at or above the owed balance (<=), boundary counts', () => {
    // manual paydown, owed 10000, rungs 15000/10000/5000 → 15000 and 10000 reached (10000 is AT).
    const g = goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 10000 });
    const v = balanceGoalView({ goal: { ...g, checkpoints: CPS(15000, 10000, 5000) }, balance: null, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsReached).toBe(2);
    expect(v.checkpointsTotal).toBe(3);
  });

  it('uses the NORMALISED current, not the raw signed balance (synced paydown fail-on-revert)', () => {
    // synced paydown, loan stored NEGATIVE (-4000 → owed 4000). Rung 3000: owed 4000 <= 3000 is
    // FALSE → not reached. Raw -4000 <= 3000 would be TRUE → wrongly reached. Locks the use of
    // `current` over the raw balance.
    const g = goal({ direction: 'paydown', target_amount: 0, checkpoints: CPS(3000) });
    expect(balanceGoalView({ goal: g, balance: -4000, payCycle: CYCLE }, TODAY).checkpointsReached).toBe(0);
  });

  it('a below-baseline rung still counts as reached (checkpoints are absolute, not baseline-relative)', () => {
    // grow, baseline 2000, balance 2000, rung 1000: absolute 2000 >= 1000 → reached, even though
    // the % bar (which counts from baseline) reads 0%. Checkpoints are absolute milestones.
    const g = goal({ baseline: 2000, checkpoints: CPS(1000) });
    const v = balanceGoalView({ goal: g, balance: 2000, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsReached).toBe(1);
    expect(v.progress).toBe(0); // bar reads 0% from the baseline; the count still says reached
  });

  it('a known balance with none reached is 0, not null (the "0 of N" line still shows)', () => {
    const g = goal({ checkpoints: CPS(5000, 8000) });
    expect(balanceGoalView({ goal: g, balance: 1000, payCycle: CYCLE }, TODAY).checkpointsReached).toBe(0);
  });

  it('an unknown (not-yet-polled synced) balance leaves reached null but keeps the total', () => {
    const g = goal({ checkpoints: CPS(2000, 4000) });
    const v = balanceGoalView({ goal: g, balance: null, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsReached).toBeNull();
    expect(v.checkpointsTotal).toBe(2);
  });

  it('a goal with no checkpoints reports total 0 and reached null (card renders nothing)', () => {
    const v = balanceGoalView({ goal: goal(), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsTotal).toBe(0);
    expect(v.checkpointsReached).toBeNull();
  });
});

describe('balanceGoalView — checkpoint marker positions (WHIT-486)', () => {
  const CPS = (...amounts: number[]) => amounts.map((amount) => ({ amount }));
  const pcts = (v: ReturnType<typeof balanceGoalView>) => v.checkpointMarkers.map((m) => m.pct);
  const reached = (v: ReturnType<typeof balanceGoalView>) => v.checkpointMarkers.map((m) => m.reached);

  it('grow, no baseline: each dot sits at amount/target, filled up to the balance', () => {
    // target 10000, balance 4000, rungs 2000/4000/6000/8000 → 0.2/0.4/0.6/0.8; 2000 & 4000 reached.
    const g = goal({ checkpoints: CPS(2000, 4000, 6000, 8000) });
    const v = balanceGoalView({ goal: g, balance: 4000, payCycle: CYCLE }, TODAY);
    expect(pcts(v)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(reached(v)).toEqual([true, true, false, false]);
  });

  it('grow with a baseline: dots measure from the baseline, same scale as the fill', () => {
    // baseline 2000, target 10000 → span 8000. rung 6000 → (6000-2000)/8000 = 0.5.
    const g = goal({ baseline: 2000, checkpoints: CPS(6000) });
    const v = balanceGoalView({ goal: g, balance: 4000, payCycle: CYCLE }, TODAY);
    expect(pcts(v)).toEqual([0.5]);
  });

  it('paydown with a baseline: a dot sits where the owed amount has fallen to', () => {
    // baseline 20000, target 0 → span 20000. owed 12000. rungs 15000/10000 → 0.25/0.5.
    const g = goal({ direction: 'paydown', target_amount: 0, baseline: 20000, checkpoints: CPS(15000, 10000) });
    const v = balanceGoalView({ goal: g, balance: -12000, payCycle: CYCLE }, TODAY);
    expect(pcts(v)).toEqual([0.25, 0.5]);
    expect(reached(v)).toEqual([true, false]); // owed 12000 <= 15000, not <= 10000
  });

  it('a dot at the current balance lands exactly on the fill edge (no drift)', () => {
    // grow, balance 4000, a rung AT 4000 → its pct equals progress.
    const g = goal({ checkpoints: CPS(4000) });
    const v = balanceGoalView({ goal: g, balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.checkpointMarkers[0].pct).toBe(v.progress);
  });

  it('clamps a rung above the target to 1 and below the baseline to 0', () => {
    const g = goal({ baseline: 2000, checkpoints: CPS(1000, 50000) }); // below baseline / above target
    const v = balanceGoalView({ goal: g, balance: 4000, payCycle: CYCLE }, TODAY);
    expect(pcts(v)).toEqual([0, 1]);
  });

  it('the number of filled dots always equals checkpointsReached', () => {
    const g = goal({ checkpoints: CPS(2000, 4000, 6000, 8000) });
    const v = balanceGoalView({ goal: g, balance: 5000, payCycle: CYCLE }, TODAY);
    expect(reached(v).filter(Boolean).length).toBe(v.checkpointsReached);
  });

  it('no dots while the balance is unknown (they appear with the count, not before)', () => {
    // synced, not yet polled → markers empty even though positions are computable (WHIT-486 Option A).
    const g = goal({ checkpoints: CPS(2000, 4000) });
    const v = balanceGoalView({ goal: g, balance: null, payCycle: CYCLE }, TODAY);
    expect(v.checkpointMarkers).toEqual([]);
  });

  it('no dots for a paydown goal with no baseline (no scale to place them on)', () => {
    // manual paydown, owed 10000, no baseline → no bar; markers empty, but the reached COUNT still
    // computes (that line is what hides on the card, together with the dots).
    const g = goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 10000, checkpoints: CPS(15000, 5000) });
    const v = balanceGoalView({ goal: g, balance: null, payCycle: CYCLE }, TODAY);
    expect(v.checkpointMarkers).toEqual([]);
    expect(v.checkpointsReached).toBe(1); // owed 10000 <= 15000 only
  });

  it('no dots for a goal with no checkpoints', () => {
    const v = balanceGoalView({ goal: goal(), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.checkpointMarkers).toEqual([]);
  });
});

// --- WHIT-478 QA gaps (adversarial): boundaries, overdrawn clamp, order-independence, paydown
// with/without baseline, non-finite balance. Dropped the below-baseline case — the implementer's
// suite above already locks it. ---
describe('WHIT-478 gaps — checkpoints reached-count', () => {
  const CPS = (...amounts: number[]) => amounts.map((amount) => ({ amount }));
  const view = (g: BalanceGoal, balance: number | null) =>
    balanceGoalView({ goal: g, balance, payCycle: CYCLE }, TODAY);

  it('overdrawn synced grow (balance −50 → current 0) reaches 0 rungs, never negative', () => {
    const g = goal({ checkpoints: CPS(1000, 4000) });
    const v = view(g, -50);
    expect(v.checkpointsReached).toBe(0);
    expect(v.progress).toBe(0); // bar clamps to 0 too → count and bar agree at the floor
  });

  it('grow at target: all rungs reached (N of N) and the bar is full — they agree at the top', () => {
    const g = goal({ checkpoints: CPS(2500, 5000, 7500) });
    const v = view(g, 10000);
    expect(v.checkpointsReached).toBe(3);
    expect(v.checkpointsTotal).toBe(3);
    expect(v.progress).toBe(1);
  });

  it('single-rung ladder: 1 of 1 when reached, 0 of 1 just below (boundary is inclusive)', () => {
    const g = goal({ checkpoints: CPS(4000) });
    expect(view(g, 4000).checkpointsReached).toBe(1);
    expect(view(g, 3999).checkpointsReached).toBe(0);
    expect(view(g, 4000).checkpointsTotal).toBe(1);
  });

  it('a full 20-rung ladder partially reached counts the passed rungs exactly', () => {
    const rungs = Array.from({ length: 20 }, (_, i) => (i + 1) * 500);
    const g = goal({ target_amount: 100000, checkpoints: CPS(...rungs) });
    expect(view(g, 5250).checkpointsReached).toBe(10);
    expect(view(g, 5250).checkpointsTotal).toBe(20);
  });

  it('an unsorted checkpoints array counts the same as the sorted one (order-independent)', () => {
    const sorted = view(goal({ checkpoints: CPS(2000, 4000, 6000, 8000) }), 4000).checkpointsReached;
    const shuffled = view(goal({ checkpoints: CPS(8000, 2000, 6000, 4000) }), 4000).checkpointsReached;
    expect(shuffled).toBe(2);
    expect(shuffled).toBe(sorted);
  });

  it('paydown WITH a baseline: progress bar and reached-count coexist and agree', () => {
    const g = goal({ direction: 'paydown', target_amount: 0, baseline: 20000, account_id: null, manual_balance: 10000, manual_as_of: '2026-07-01', checkpoints: CPS(15000, 10000, 5000) });
    const v = view(g, null);
    expect(v.progress).toBeCloseTo(0.5, 10);
    expect(v.checkpointsReached).toBe(2);
    expect(v.checkpointsTotal).toBe(3);
  });

  it('paydown without a baseline: progress null (no bar) yet the reached-count still computes', () => {
    const g = goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 8000, manual_as_of: '2026-07-01', checkpoints: CPS(12000, 6000) });
    const v = view(g, null);
    expect(v.progress).toBeNull();
    expect(v.checkpointsReached).toBe(1);
    expect(v.checkpointsTotal).toBe(2);
  });

  it('manual paydown owed exactly on a rung counts it (inclusive ≤ boundary)', () => {
    const g = goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 5000, manual_as_of: '2026-07-01', checkpoints: CPS(5000) });
    expect(view(g, null).checkpointsReached).toBe(1);
  });

  it('a non-finite synced balance is unknown → reached null (line hides), total preserved', () => {
    const g = goal({ checkpoints: CPS(2000, 4000) });
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = view(g, bad);
      expect(v.checkpointsReached).toBeNull();
      expect(v.checkpointsTotal).toBe(2);
    }
  });
});
