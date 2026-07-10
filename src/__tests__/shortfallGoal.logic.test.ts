// WHIT-126 — the "won't pay off" state turned actionable. When paydownView is in the
// 'none' mode (the loan never clears at the current repayment) AND the user has set a
// future payoff goal date, it solves the required repayment; aiGoalSignal then emits a
// 'shortfall' signal for the AI layer. Pure over makeState + an injected `today`.
import { describe, it, expect } from '@jest/globals';
import { paydownView, aiGoalSignal, amortize } from '../context';
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

  it('is null in the shortfall state when no goal date is set', () => {
    expect(aiGoalSignal(SHORTFALL_STATE(null), TODAY)).toBeNull();
  });
});

// WHIT-215 — the "goal too aggressive" flag on paydownView. Fires in TWO shortfall states:
// (1) the required repayment is over the $1M cap → figure suppressed; (2) it's under the cap
// but an absurd multiple (>10×) of the current repayment → figure shown. Drives the Goal
// screen's "try a later date" hint. False for a realistic goal, no date, or a past date.
describe('paydownView goalTooAggressive flag (WHIT-215)', () => {
  const AGGRESSIVE_MULTIPLE = 10; // mirrors AGGRESSIVE_REPAY_MULTIPLE in context.tsx
  const CURRENT = M.baseRepay + M.extra; // 4167 — the user's current monthly repayment
  const OVER_CAP_STATE = (payoffGoalDate: string) =>
    makeState({ loanFacts: { ...M, payoffGoalDate }, homeLoan: { balance: 1_200_000, asOf: null } });

  it('flags true when the required repayment exceeds the $1M cap (figure suppressed)', () => {
    const pv = paydownView(OVER_CAP_STATE('2026-08-01'), TODAY); // next month on 1.2M → ~$1.2M/mo
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).toBeNull();      // figure stays hidden (unchanged behaviour)
    expect(pv.goalTooAggressive).toBe(true);  // ...but the hint now fires
  });

  it('flags true for an absurd-but-under-$1M figure (> 10× current repayment)', () => {
    const pv = paydownView(SHORTFALL_STATE('2027-01-01'), TODAY); // 6 months on 900k → ~$150k/mo
    expect(pv.requiredRepay).not.toBeNull();                      // an honest figure IS shown
    expect(pv.requiredRepay!).toBeGreaterThan(AGGRESSIVE_MULTIPLE * CURRENT);
    expect(pv.goalTooAggressive).toBe(true);                     // hint accompanies the figure
  });

  it('does NOT flag a realistic future goal (figure shown, reasonable multiple)', () => {
    const pv = paydownView(SHORTFALL_STATE('2035-06-01'), TODAY); // ~$10.8k/mo, well under 10×
    expect(pv.requiredRepay).not.toBeNull();
    expect(pv.requiredRepay!).toBeLessThanOrEqual(AGGRESSIVE_MULTIPLE * CURRENT);
    expect(pv.goalTooAggressive).toBe(false);
  });

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
