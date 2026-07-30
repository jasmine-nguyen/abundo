// WHIT-378 — adversarial GAP coverage for goalView's depositPct (QA, not implementer).
// Implementer's selectors.logic.test.ts locks: null with no target/no equity, ratio
// clamped to 100, null with target-but-no-balance. These add the boundaries it skips:
//   [A10] usableEquity is EXACTLY 0 (clamped) but a target IS set -> depositPct is 0,
//         NOT null: the "0 != null" edge that keeps a 0%-bar showing (regression guard
//         against a truthy `if (usableEquity)` slip that would hide it).
//   [A11] a non-round ratio is returned UNROUNDED by the selector (49.6, not 50) — the
//         chip rounding lives in mortgage.tsx, so the selector must stay exact.
import { describe, it, expect } from '@jest/globals';
import { goalView } from '../context';
import { makeState, LOAN_FACTS } from './factory';

describe('goalView depositPct — boundary gaps (WHIT-378)', () => {
  // homeValue 770000 × lvr 0.8 = 616000 usable ceiling.
  it('[A10] equity clamped to exactly 0 with a target set -> depositPct is 0, not null', () => {
    // balance 616000 -> raw equity 0 (usableEquity() clamps at 0). Target IS set.
    const facts = { ...LOAN_FACTS, depositTarget: 100000 };
    const v = goalView(makeState({ loanFacts: facts, homeLoan: { balance: 616000, asOf: null } }));
    expect(v.usableEquity).toBe(0);
    expect(v.depositPct).toBe(0);          // 0/100000 -> 0, and 0 !== null so the bar renders
    expect(v.depositPct).not.toBeNull();   // fail-on-revert: a truthy guard would drop this to null
  });

  it('[A11] non-round ratio is returned exact (49.6), NOT pre-rounded in the selector', () => {
    // balance 566400 -> equity 49600; target 100000 -> 49.6%. Selector must NOT round.
    const facts = { ...LOAN_FACTS, depositTarget: 100000 };
    const v = goalView(makeState({ loanFacts: facts, homeLoan: { balance: 566400, asOf: null } }));
    expect(v.usableEquity).toBe(49600);
    expect(v.depositPct).toBeCloseTo(49.6, 5);
  });
});
