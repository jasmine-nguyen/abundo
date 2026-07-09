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
