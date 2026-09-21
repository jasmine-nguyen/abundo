// WHIT-134 GAP — the honest-NULL sensitivity + the no-signal boundaries of
// aiGoalSignal. The main aiGoalSignal.logic test only asserts a positive sensitivity;
// this locks the `months_sooner_per_100_extra: null` branch (the field's whole reason
// for being nullable, and the linchpin of "only claim months-sooner when present") and
// re-guards the modes that must emit NO loan signal at all.
import { describe, it, expect } from '@jest/globals';
import { aiGoalSignal, paydownView, requiredRepayment } from '../context';
import { makeState, asPayoffGoal, asShortfallGoal } from './factory';

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

// ===== WHIT-218 (adversarial GAPS, folded from aiGoalSignalSuppress.gaps) — aiGoalSignal
// SUPPRESSES the shortfall signal when the payoff goal date is goalTooAggressive, so the AI never
// receives an absurd required figure. These add the parts the sibling files DIDN'T pin:
//   1. the EXACT 10× flip translated to aiGoalSignal: one dollar below the line SUPPRESSES,
//      one dollar above EMITS the full payload (fine boundary AND anti-over-suppression in one pair).
//   2. a payoff arm ('ahead') with an aggressively-soon goal date still emits its payoff signal —
//      the new gate lives inside the 'none' branch and must not touch payoff arms.
// Reuses the module-level TODAY + M above (byte-identical to the gaps file's).
const I = 5.74 / 100 / 12;                 // the fixture monthly rate
const stateWith = (over: Partial<typeof M> & { payoffGoalDate?: string | null }, balance: number) =>
  makeState({ loanFacts: { ...M, ...over }, homeLoan: { balance, asOf: null } });

// [A-boundary] The 10× flip, seen through aiGoalSignal. Hold the required figure fixed
// (900k, 24 months → ~$39,783, under the $1M cap so it solves) and slide currentRepay one
// dollar across R/10. Below the line the goal is flagged → the signal is SUPPRESSED (null);
// one dollar above, the SAME figure/date is not flagged → the signal EMITS in full. This is
// the exact WHIT-218 boundary and simultaneously proves we did NOT over-suppress.
describe('WHIT-218 aiGoalSignal — exact 10× flip: suppress vs emit (NEW)', () => {
  const R = requiredRepayment(900000, I, 24)!;   // ~39,783.19 — the production solver, not a re-impl

  it('one dollar BELOW the 10× line → flagged → signal SUPPRESSED (null)', () => {
    const s = stateWith({ baseRepay: 3478, extra: 500, payoffGoalDate: '2028-07-01' }, 900000); // current 3978
    const pv = paydownView(s, TODAY);
    expect(pv.mode).toBe('none');
    expect(pv.requiredRepay).not.toBeNull();            // the figure IS solved (under the $1M cap)…
    expect(pv.requiredRepay!).toBeCloseTo(R, 6);
    expect(pv.goalTooAggressive).toBe(true);
    expect(aiGoalSignal(s, TODAY)).toBeNull();          // …but WHIT-218 keeps it from the AI
  });

  it('one dollar ABOVE the 10× line → not flagged → signal EMITS the full shortfall payload', () => {
    const s = stateWith({ baseRepay: 3479, extra: 500, payoffGoalDate: '2028-07-01' }, 900000); // current 3979
    const pv = paydownView(s, TODAY);
    expect(pv.goalTooAggressive).toBe(false);           // same date + figure, only the multiple changed
    const g = asShortfallGoal(aiGoalSignal(s, TODAY));  // NOT suppressed — proves no over-suppression
    expect(g.goal_date).toBe('Jul 2028');
    expect(g.required_repayment).toBe(pv.requiredRepay);
    expect(g.required_extra).toBe(pv.requiredExtra);
    expect(g.current_extra_monthly).toBe(500);
  });
});

// [A-payoff] Regression guard: the WHIT-218 gate sits INSIDE the 'none' shortfall branch.
// A loan that DOES pay off ('ahead') keeps goalTooAggressive=false even with the most
// aggressive possible goal date, so its payoff signal must emit untouched. Guards a future
// refactor that hoists the flag out of the shortfall branch and accidentally suppresses payoff arms.
describe('WHIT-218 aiGoalSignal — payoff arm unaffected by a soon goal date (NEW)', () => {
  it("'ahead' loan with a one-month-away goal date still emits its payoff signal", () => {
    const s = stateWith({ payoffGoalDate: '2026-08-01' }, 528000); // pays off → 'ahead', flag stays false
    const pv = paydownView(s, TODAY);
    expect(pv.mode).toBe('ahead');
    expect(pv.goalTooAggressive).toBe(false);
    const g = asPayoffGoal(aiGoalSignal(s, TODAY));
    expect(g.payoff_mode).toBe('ahead');
    expect(g.mortgage_free_date).toBe('Nov 2042');       // unchanged by the goal date
    expect(g.months_sooner_per_100_extra).toBe(7);
  });
});
