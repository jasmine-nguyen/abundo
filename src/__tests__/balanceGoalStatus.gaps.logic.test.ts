// WHIT-262 — balanceGoalView.status ADVERSARIAL GAPS (independent of the status describe block
// the implementer added to balanceGoal.logic.test.ts; do not duplicate those). Hunts the corners
// they left open: start_balance === 0 (falsy but a REAL start), the progress-bar vs status
// DIVERGENCE the interface comment promises, a goal MET mid-timeline, a fill driven negative,
// paydown denom guards for a zero / in-credit synced start, NON-FINITE start_balance, and the
// elapsed==0 / elapsed==total day boundaries. Every expected is hand-computed and reasoned in
// Melbourne TZ (runner pins TZ=Australia/Melbourne).
// Anchor: start Jun6 -> target Aug15 = 70 days; TODAY Jul11 = 35 elapsed -> expected fill 0.5,
// on-track band [0.45, 0.55] (tolerance 0.05).
import { describe, it, expect } from '@jest/globals';
import { balanceGoalView, BalanceGoal } from '../context';

const CYCLE = { length: 14, last_pay_date: '2026-06-06' };
const TODAY = new Date(2026, 6, 11); // Sat 11 Jul 2026, Melbourne local midnight

function goal(over: Partial<BalanceGoal> = {}): BalanceGoal {
  return { direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending', ...over };
}
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
