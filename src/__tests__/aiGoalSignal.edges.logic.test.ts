// WHIT-134 GAP — the honest-NULL sensitivity + the no-signal boundaries of
// aiGoalSignal. The main aiGoalSignal.logic test only asserts a positive sensitivity;
// this locks the `months_sooner_per_100_extra: null` branch (the field's whole reason
// for being nullable, and the linchpin of "only claim months-sooner when present") and
// re-guards the modes that must emit NO loan signal at all.
import { describe, it, expect } from '@jest/globals';
import { aiGoalSignal } from '../context';
import { makeState, asPayoffGoal } from './factory';

const TODAY = new Date(2026, 6, 4);
const M = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };

describe('aiGoalSignal — sensitivity null branch + no-signal modes (WHIT-134)', () => {
  it('sends the goal but a NULL sensitivity when +$100 moves the payoff < half a month', () => {
    // A near-cleared balance clears in weeks; an extra $100/mo can't shift a whole
    // month, so the exact sensitivity is omitted (null) — never 0, never a fabricated
    // ">=1 month". The goal itself (mode + date) still goes.
    const g = asPayoffGoal(aiGoalSignal(makeState({ loanFacts: M, homeLoan: { balance: 100, asOf: null } }), TODAY));
    expect(['partial', 'flat', 'ahead']).toContain(g.payoff_mode);
    expect(g.months_sooner_per_100_extra).toBeNull();
  });

  it("emits nothing about the loan for the 'none' mode (a balance that never clears)", () => {
    expect(aiGoalSignal(makeState({ loanFacts: M, homeLoan: { balance: 1_000_000_000, asOf: null } }), TODAY)).toBeNull();
  });

  it('is null when the live balance is NaN (never leaks a junk date into the goal)', () => {
    expect(aiGoalSignal(makeState({ loanFacts: M, homeLoan: { balance: NaN, asOf: null } }), TODAY)).toBeNull();
  });
});
