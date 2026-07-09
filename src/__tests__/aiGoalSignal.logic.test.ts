// WHIT-134 — the AI home-loan goal signal derived from WHIT-114's payoff projection.
// Pure over a cast partial AppContext (makeState), like the sibling selector tests.
// The signal reuses paydownView/amortize (the single source of truth), so a revert of
// the projection would move these expectations too.
import { describe, it, expect } from '@jest/globals';
import { aiGoalSignal } from '../context';
import { makeState, EMPTY_LOAN_FACTS, asPayoffGoal } from './factory';

const TODAY = new Date(2026, 6, 4); // 2026-07-04, fixed so the projected month is stable.
const M = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };

describe('aiGoalSignal (WHIT-134)', () => {
  it('is null until loan facts AND the live balance are ready', () => {
    expect(aiGoalSignal(makeState({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 528000, asOf: null } }), TODAY)).toBeNull();
    expect(aiGoalSignal(makeState({ loanFacts: M, homeLoan: { balance: null, asOf: null } }), TODAY)).toBeNull();
  });

  it('is null when the loan never pays off (no honest payoff date to send)', () => {
    // B=900000: the payment can't cover the interest -> paydownView 'none'.
    expect(aiGoalSignal(makeState({ loanFacts: M, homeLoan: { balance: 900000, asOf: null } }), TODAY)).toBeNull();
  });

  it('carries the projected date, current extra, and an exact per-$100 sensitivity (ahead)', () => {
    const g = asPayoffGoal(aiGoalSignal(makeState({ loanFacts: M, homeLoan: { balance: 528000, asOf: null } }), TODAY));
    expect(g.payoff_mode).toBe('ahead');
    expect(g.mortgage_free_date).toBe('Nov 2042');   // matches paydownView; fail-on-revert vs old seed
    expect(g.current_extra_monthly).toBe(500);
    // Exact months the payoff moves in per extra $100/mo — anchored (not just >0) so
    // a change to the +$100 step or the rounding is caught, like mortgage_free_date.
    expect(g.months_sooner_per_100_extra).toBe(7);
  });

  it('still sends the date for a partial payoff (the extra is what clears it)', () => {
    const g = asPayoffGoal(aiGoalSignal(makeState({ loanFacts: M, homeLoan: { balance: 815000, asOf: null } }), TODAY));
    expect(g.payoff_mode).toBe('partial');
    expect(g.mortgage_free_date).toBe('Jun 2074');
    expect(g.months_sooner_per_100_extra).toBe(61);
  });

  it('reports extra 0 for a flat payoff but still offers the $100 lever', () => {
    const g = asPayoffGoal(aiGoalSignal(makeState({ loanFacts: { ...M, extra: 0 }, homeLoan: { balance: 528000, asOf: null } }), TODAY));
    expect(g.payoff_mode).toBe('flat');
    expect(g.current_extra_monthly).toBe(0);
    expect(g.months_sooner_per_100_extra).toBe(12);
  });
});
