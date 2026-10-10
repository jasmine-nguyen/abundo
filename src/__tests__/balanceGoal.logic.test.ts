// WHIT-232 / WHIT-262 — balanceGoalView + paydaysUntil: the pure goal pace engine. Progress %
// and per-payday pace for grow (savings) and paydown (debt), source-aware sign normalisation,
// every denominator guarded. Status (ahead/on_track/behind) measured from the immutable start.
// Expecteds are computed by hand in the comments so a revert fails. Runner pins
// TZ=Australia/Melbourne (package.json).
import { describe, it, expect } from '@jest/globals';
import { paydaysUntil, balanceGoalView, BalanceGoal } from '../context';

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
});

// --- WHIT-262: ahead / on-track / behind from the immutable start -------------
// Start Jun6 -> target Aug15 = 70 days; TODAY Jul11 = 35 elapsed -> expected fill 0.5.
// Tolerance 0.05 -> on-track band [0.45, 0.55]. All fractions hand-computed so a revert fails.
describe('balanceGoalView — status (WHIT-262)', () => {
  const START = { start_date: '2026-06-06', start_balance: 2000 }; // grow: startN 2000, denom 8000
  const paced = (over: Partial<BalanceGoal> = {}) => goal({ ...START, ...over });

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

  it('[A20] weekly (len 7): (Jul11, Aug1] -> Jul15,22,29 = 3', () => {
    expect(paydaysUntil(W, '2026-08-01', TODAY)).toBe(3);
  });

  it('[A23] target BEFORE last_pay_date -> 0 (no negative count)', () => {
    expect(paydaysUntil(W, '2026-06-20', TODAY)).toBe(0);
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

  it('[A35] NaN / Infinity synced balance is guarded to null (unknown), paydays still count', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const v = balanceGoalView({ goal: goal(), balance: bad, payCycle: CYCLE }, TODAY);
      expect(v.progress).toBeNull();
      expect(v.pacePerPayday).toBeNull();
      expect(v.paydaysLeft).toBe(3);
    }
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
});

describe('balanceGoalView — pace/paydaysLeft', () => {
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

// --- paydown synced denom guard: a start already clear / in credit -------------
describe('paydown synced start with nothing to measure -> null', () => {
  const debt = (over: Partial<BalanceGoal> = {}) =>
    goal({ direction: 'paydown', target_amount: 0, baseline: 20000, start_date: '2026-06-06', ...over });

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
  });

  it('paydown: counts the rungs at or above the owed balance (<=), boundary counts', () => {
    // manual paydown, owed 10000, rungs 15000/10000/5000 → 15000 and 10000 reached (10000 is AT).
    const g = goal({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 10000 });
    const v = balanceGoalView({ goal: { ...g, checkpoints: CPS(15000, 10000, 5000) }, balance: null, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsReached).toBe(2);
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

  it('an unknown (not-yet-polled synced) balance leaves reached null', () => {
    const g = goal({ checkpoints: CPS(2000, 4000) });
    const v = balanceGoalView({ goal: g, balance: null, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsReached).toBeNull();
  });

  it('a goal with no checkpoints reports reached null and no markers (card renders nothing)', () => {
    const v = balanceGoalView({ goal: goal(), balance: 4000, payCycle: CYCLE }, TODAY);
    expect(v.checkpointsReached).toBeNull();
    expect(v.checkpointMarkers).toEqual([]);
  });
});

describe('balanceGoalView — targetReached (WHIT-747)', () => {
  const at = (g: BalanceGoal, balance: number | null) =>
    balanceGoalView({ goal: g, balance, payCycle: CYCLE }, TODAY).targetReached;

  it('grow: reached at or above the target, not below', () => {
    expect(at(goal(), 9999)).toBe(false);
    expect(at(goal(), 10000)).toBe(true);
    expect(at(goal(), 12000)).toBe(true);
  });

  it('paydown (synced, owed stored negative): reached at or below the target owed', () => {
    const g = goal({ direction: 'paydown', target_amount: 1000, account_id: 'up-loan' });
    expect(at(g, -1001)).toBe(false);
    expect(at(g, -1000)).toBe(true);
    expect(at(g, -200)).toBe(true);
  });

  it('is null while the balance is unknown', () => {
    expect(at(goal(), null)).toBeNull();
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

  it('clamps a rung above the target to 1 and below the baseline to 0', () => {
    const g = goal({ baseline: 2000, checkpoints: CPS(1000, 50000) }); // below baseline / above target
    const v = balanceGoalView({ goal: g, balance: 4000, payCycle: CYCLE }, TODAY);
    expect(pcts(v)).toEqual([0, 1]);
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
});

// WHIT-486 QA gaps (adversarial): strengthen the raw-not-rounded pct guarantee, duplicate rungs,
// and the degenerate progress==null case where the reached COUNT still computes but there is no
// bar to place dots on (Option A coupling lives at the UI layer, not here).
describe('balanceGoalView — checkpoint markers, QA gaps (WHIT-486)', () => {
  const CPS = (...amounts: number[]) => amounts.map((amount) => ({ amount }));

  it('[A-gap1] dot pct is the RAW fraction, not the rounded % — cp==current, non-round balance', () => {
    // target 10000, balance 3333, a rung AT 3333. progress = 0.3333 (not 0.33, not 33%).
    // Asserted against a LITERAL, so a bug that rounds BOTH progress and pct can't hide behind
    // `pct === progress`.
    const g = goal({ checkpoints: CPS(3333) });
    const v = balanceGoalView({ goal: g, balance: 3333, payCycle: CYCLE }, TODAY);
    expect(v.checkpointMarkers[0].pct).toBeCloseTo(0.3333, 10);
    expect(v.checkpointMarkers[0].pct).toBe(v.progress);     // still lands exactly on the fill edge
    expect(v.checkpointMarkers[0].pct).not.toBe(0.33);       // not rounded to 2dp
  });
});

describe('balanceGoalView — pastDue / currentAmount / checkpointReached (WHIT-749)', () => {
  const view = (over: Partial<BalanceGoal>, balance: number | null = 4000) =>
    balanceGoalView({ goal: goal(over), balance, payCycle: CYCLE }, TODAY);

  it('pastDue is true only when the target date is strictly before today', () => {
    expect(view({ target_date: '2026-07-10' }).pastDue).toBe(true);
    expect(view({ target_date: '2026-07-11' }).pastDue).toBe(false);
    // ahead of today but before the next payday (Jul 18): 0 paydays left, yet not past due
    const soon = view({ target_date: '2026-07-15' });
    expect(soon.paydaysLeft).toBe(0);
    expect(soon.pastDue).toBe(false);
  });

  // the boundary is the device's local day: 23:59 on the target day is not past; 00:00 the next is.
  it('[A1] flips at local midnight after the target date, not before', () => {
    const g = goal({ target_date: '2026-07-11' });
    const at = (d: Date) => balanceGoalView({ goal: g, balance: 4000, payCycle: CYCLE }, d).pastDue;
    expect(at(new Date(2026, 6, 11, 23, 59))).toBe(false);
    expect(at(new Date(2026, 6, 12, 0, 0))).toBe(true);
  });

  it('currentAmount is the normalised balance: saved for grow, owed for paydown', () => {
    expect(view({}, 4000).currentAmount).toBe(4000);
    expect(view({ direction: 'paydown', target_amount: 0 }, -9000).currentAmount).toBe(9000);
    expect(view({ direction: 'paydown', target_amount: 0, account_id: null, manual_balance: 9000 }, null).currentAmount).toBe(9000);
  });

  it('checkpointReached flags each checkpoint and agrees with the count', () => {
    const v = view({ checkpoints: [{ amount: 2000 }, { amount: 5000 }, { amount: 4000 }] }, 4000);
    expect(v.checkpointReached).toEqual([true, false, true]);
    expect(v.checkpointsReached).toBe(2);
  });
});
