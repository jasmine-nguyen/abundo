// WHIT-126 — the "won't pay off" state turned actionable. When paydownView is in the
// 'none' mode (the loan never clears at the current repayment) AND the user has set a
// future payoff goal date, it solves the required repayment; aiGoalSignal then emits a
// 'shortfall' signal for the AI layer. Pure over makeState + an injected `today`.
import { describe, it, expect } from '@jest/globals';
import { paydownView, aiGoalSignal, amortize, requiredRepayment } from '../context';
import { makeState, asShortfallGoal } from './factory';

const TODAY = new Date(2026, 6, 4);        // 2026-07-04
// B=900000 with these facts is a 'none' case: baseRepay+extra (4167) < interest (≈4305).
const M = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };
const SHORTFALL_STATE = (payoffGoalDate: string | null) =>
  makeState({ loanFacts: { ...M, payoffGoalDate }, homeLoan: { balance: 900000, asOf: null } });

describe('paydownView shortfall solver (WHIT-126)', () => {
  it('solves the required repayment for a valid future goal date', () => {
    const pv = paydownView(SHORTFALL_STATE('2035-06-01'), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.goalDateLabel).toBe('Jun 2035');
    expect(pv.requiredRepay).not.toBeNull();
    // Round-trips: paying requiredRepay clears 900k in the months to Jun 2035 (107).
    const months = (2035 - 2026) * 12 + (6 - 7);
    expect(amortize(900000, 5.74 / 100 / 12, pv.requiredRepay!)!.periods).toBeCloseTo(months, 3);
    // It's more than they pay now, and requiredExtra is that positive gap.
    expect(pv.requiredExtra).toBeGreaterThan(0);
    expect(pv.requiredExtra).toBeCloseTo(pv.requiredRepay! - (M.baseRepay + M.extra), 6);
    expect(pv.requiredRepayLabel).toBeTruthy();
    expect(pv.requiredExtraLabel).toBeTruthy();
  });

  it('leaves the shortfall fields null with no goal date (falls back to static copy)', () => {
    const pv = paydownView(SHORTFALL_STATE(null), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).toBeNull();
    expect(pv.requiredExtra).toBeNull();
    expect(pv.goalDateLabel).toBeNull();
  });

  it('ignores a past / current-month goal date (no absurd figure from n ≤ 0)', () => {
    expect(paydownView(SHORTFALL_STATE('2020-01-01'), TODAY).requiredRepay).toBeNull(); // past
    expect(paydownView(SHORTFALL_STATE('2026-07-15'), TODAY).requiredRepay).toBeNull(); // this month → n=0
  });
});

describe('aiGoalSignal shortfall variant (WHIT-126)', () => {
  it('emits a shortfall signal carrying the required repayment for a future goal date', () => {
    const pv = paydownView(SHORTFALL_STATE('2035-06-01'), TODAY);
    const g = asShortfallGoal(aiGoalSignal(SHORTFALL_STATE('2035-06-01'), TODAY));
    expect(g.goal_date).toBe('Jun 2035');
    expect(g.required_repayment).toBe(pv.requiredRepay);
    expect(g.required_extra).toBe(pv.requiredExtra);
    expect(g.current_extra_monthly).toBe(500);
    // The goal_date MUST match the server's "Mon YYYY" goal-date shape, or _sanitise_goal
    // silently drops the whole signal — the AI layer would never fire. Fail-on-revert if
    // a future change sends the ISO string instead of the month-year label.
    expect(/^[A-Z][a-z]{2} \d{4}$/.test(g.goal_date)).toBe(true);
  });
});

// WHIT-215 — the "goal too aggressive" flag on paydownView. Fires in TWO shortfall states:
// (1) the required repayment is over the $1M cap → figure suppressed; (2) it's under the cap
// but an absurd multiple (>10×) of the current repayment → figure shown. Drives the Goal
// screen's "try a later date" hint. False for a realistic goal, no date, or a past date.
describe('paydownView goalTooAggressive flag (WHIT-215)', () => {
  it('does NOT flag with no goal date, or a past / current-month date', () => {
    expect(paydownView(SHORTFALL_STATE(null), TODAY).goalTooAggressive).toBe(false);
    expect(paydownView(SHORTFALL_STATE('2020-01-01'), TODAY).goalTooAggressive).toBe(false); // past
    expect(paydownView(SHORTFALL_STATE('2026-07-15'), TODAY).goalTooAggressive).toBe(false); // n=0
  });

  it('does NOT flag on a $0 current repayment (the multiple guard prevents a false positive)', () => {
    // With base+extra === 0, "> 10× current" would trip on ANY positive figure — the
    // currentRepay > 0 guard keeps the multiple-based hint off (the real problem there is
    // a $0 repayment, not the date).
    const zeroRepay = makeState({
      loanFacts: { ...M, baseRepay: 0, extra: 0, payoffGoalDate: '2035-06-01' },
      homeLoan: { balance: 900000, asOf: null },
    });
    const pv = paydownView(zeroRepay, TODAY);
    expect(pv.requiredRepay).not.toBeNull();     // a figure still solves
    expect(pv.goalTooAggressive).toBe(false);    // ...but not flagged via the multiple
  });
});

const STATE = (balance: number, payoffGoalDate: string | null, over: Partial<typeof M> = {}) =>
  makeState({ loanFacts: { ...M, ...over, payoffGoalDate }, homeLoan: { balance, asOf: null } });

// The exact 10× flip and the $1M cap. requiredRepay is independent of the current repayment, so
// hold the figure fixed (900k, 24 months out → ~$39,783, under the cap) and slide currentRepay
// one dollar either side of R/10.
describe('paydownView goalTooAggressive — 10× flip and $1M cap (WHIT-215 / WHIT-218)', () => {
  // monthsUntil(2026-07-04 → 2028-07-01) = 24; keep this in sync with the date below.
  const R = requiredRepayment(900000, 5.74 / 100 / 12, 24)!;

  it('flags true when currentRepay is one dollar BELOW the 10× line (10×3978 < required)', () => {
    // the boundary is real, not luck: R sits strictly between 3978×10 and 3979×10.
    expect(R).toBeGreaterThan(3978 * 10);
    expect(R).toBeLessThan(3979 * 10);
    const pv = paydownView(STATE(900000, '2028-07-01', { baseRepay: 3478 }), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).not.toBeNull();          // under the $1M cap → figure shown
    expect(pv.requiredRepay!).toBeCloseTo(R, 6);
    expect(pv.goalTooAggressive).toBe(true);
  });

  it('does NOT flag one dollar ABOVE the 10× line (10×3979 > required)', () => {
    const pv = paydownView(STATE(900000, '2028-07-01', { baseRepay: 3479 }), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).not.toBeNull();
    expect(pv.goalTooAggressive).toBe(false);         // same date, same figure — only the multiple changed
  });

  it('just OVER the cap: figure suppressed but still flagged (same too-soon date)', () => {
    const pv = paydownView(STATE(995300, '2026-08-01'), TODAY); // R ≈ 1,000,060
    expect(pv.requiredRepay).toBeNull();               // over $1M → hidden (WHIT-126 behaviour intact)
    expect(pv.goalTooAggressive).toBe(true);           // WHIT-215: the hint replaces the static copy
  });

  it('under-cap "too aggressive" now SUPPRESSES the signal (real figure, but emit null)', () => {
    const s = STATE(900000, '2027-01-01'); // 6 months → ~150k, flagged
    const pv = paydownView(s, TODAY);
    expect(pv.goalTooAggressive).toBe(true);
    expect(pv.requiredRepay).not.toBeNull();     // the figure IS solved (under the $1M cap)…
    expect(aiGoalSignal(s, TODAY)).toBeNull();   // …but NOT sent to the AI (WHIT-218 suppression)
  });
});

// WHIT-126 adversarial gaps — the shortfall solver's HORIZON math and cross-layer seams: a
// malformed stored goal date, the year boundary, month-granularity (day-of-month ignored), and a
// required repayment that overshoots the server's $1M sanitise cap.
describe('shortfall solver — malformed / unparseable goal date (WHIT-126)', () => {
  // monthsUntil splits on "-" and requires 3 finite parts; anything else -> null ->
  // paydownView must fall back to the static copy, never crash or emit a figure. A
  // corrupt/legacy stored value (the client hydrates whatever the row holds) hits this.
  it.each([
    ['not-a-date'],       // split('-') -> ["not","a","date"], Number -> NaN
    ['2035-06'],          // only 2 parts
    ['2035/06/01'],       // wrong separator -> 1 part
    ['garbage'],
    [''],                 // empty string
  ])('falls back (null shortfall fields) for a malformed goal date %p', (bad) => {
    const pv = paydownView(STATE(900000, bad), TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).toBeNull();
    expect(pv.goalDateLabel).toBeNull();
    // ...and no shortfall signal is emitted, so the AI layer stays spend-only.
    expect(aiGoalSignal(STATE(900000, bad), TODAY)).toBeNull();
  });
});

describe('shortfall solver — server $1M cap alignment (WHIT-126)', () => {
  // The server's _sanitise_goal drops the shortfall block when required_repayment
  // exceeds 1_000_000 (so the AI can't discuss it). The client mirrors that cap
  // (MAX_SHORTFALL_REPAYMENT), so a big loan with a near-term goal — which would need
  // > $1M/month — falls back to the static copy instead of showing a figure the AI
  // silently ignores. Fail-on-revert if the client cap is removed.
  it('falls back (no figure, no signal) when the required repayment would exceed the $1M cap', () => {
    const pv = paydownView(STATE(1_200_000, '2026-08-01'), TODAY); // next month, n=1 -> ~$1.2M/mo
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).toBeNull();
    expect(pv.goalDateLabel).toBeNull();
    expect(aiGoalSignal(STATE(1_200_000, '2026-08-01'), TODAY)).toBeNull();
  });
});
