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
