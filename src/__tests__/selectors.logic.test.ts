// Logic tests for the two pure selectors WHIT-90 calls out as untested:
// budgetEditInfo and goalView. Pure functions over a cast partial AppContext
// (makeState), like the sibling budget/format selector tests.
import { describe, it, expect } from '@jest/globals';
import { budgetEditInfo, goalView } from '../context';
import type { BudgetEditInput } from '../context';
import { makeState, cat, budget, EMPTY_LOAN_FACTS, LOAN_FACTS } from './factory';

describe('budgetEditInfo', () => {
  it('is in "set" mode with no existing budget', () => {
    const s = makeState({ categories: [cat({ id: 'coffee' })], budgets: [] });
    const info = budgetEditInfo(s, 'coffee');
    expect(info.existing).toBeUndefined();
    expect(info.title).toBe('Set budget');
    expect(info.saveText).toBe('Add budget');
  });

  it('is in "edit" mode when a budget already exists', () => {
    const s = makeState({
      categories: [cat()],
      budgets: [budget({ id: 'coffee', budget: 80 })],
    });
    const info = budgetEditInfo(s, 'coffee');
    expect(info.existing).toBeTruthy();
    expect(info.title).toBe('Edit budget');
    expect(info.saveText).toBe('Update budget');
  });

  it('frames Income as an earn-target (no Smoothing) and spend as spend (WHIT-169)', () => {
    const s = makeState({ categories: [cat(), cat({ id: 'salary', bucket: 'Income' })], budgets: [] });
    const spend = budgetEditInfo(s, 'coffee');
    const income = budgetEditInfo(s, 'salary');
    expect(spend.smoothingShown).toBe(true);
    expect(income.smoothingShown).toBe(false);
  });

  it('does not throw on a cold cache (category lookup empty)', () => {
    const cold: BudgetEditInput = {
      category: () => undefined,
      budgets: [],
      cycleName: 'Fortnightly',
    };
    const info = budgetEditInfo(cold, 'missing');
    expect(info.category).toBeUndefined();
    expect(info.existing).toBeUndefined();
    expect(info.title).toBe('Set budget');
  });
});

describe('goalView', () => {
  it('computes paid-off, usable equity, and contribution from saved facts + the live balance', () => {
    // LOAN_FACTS: original 500000, homeValue 770000, lvr 0.8, baseRepay 1240, extra 200.
    // The live balance comes from s.homeLoan (WHIT-8), NOT the seed goal.balance
    // (432900). A distinct value (430000) pins the source: reading goal.balance
    // instead would give paidOff 67100/equity 183100 and fail here.
    const v = goalView(makeState({ homeLoan: { balance: 430000, asOf: null } }));
    expect(v.factsReady).toBe(true);
    expect(v.paidOff).toBe(70000);                       // 500000 - 430000 (live)
    expect(v.paidPct).toBeCloseTo((70000 / 500000) * 100, 5);
    expect(v.usableEquity).toBe(186000);                 // round(770000*0.8) - 430000
    expect(v.contribution).toBe(1440);                   // baseRepay + extra
  });

  it('is not ready and nulls the figures until loan facts are saved', () => {
    const v = goalView(makeState({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 432900, asOf: null } }));
    expect(v.factsReady).toBe(false);
    expect(v.paidOff).toBeNull();
    expect(v.usableEquity).toBeNull();
    expect(v.contribution).toBeNull();
    // The live balance is still surfaced — the one thing we genuinely know.
    expect(v.balanceLabel).toBe('$432,900');
  });

  // Edge cells the happy path hides (qa gap tests).
  it('facts saved but balance NULL: contribution shows, payoff/equity stay null, label "—"', () => {
    const v = goalView(makeState({ homeLoan: { balance: null, asOf: null } }));
    expect(v.factsReady).toBe(true);
    expect(v.balanceKnown).toBe(false);
    expect(v.balanceLabel).toBe('—');
    expect(v.contribution).toBe(1440);   // needs only the facts
    expect(v.paidOff).toBeNull();         // needs the live balance -> stays null
    expect(v.paidPct).toBe(0);
    expect(v.usableEquity).toBeNull();
    expect(v.depositPct).toBeNull();      // no equity yet -> null (no fake %), never NaN
  });

  it('live balance ABOVE the original loan: paidOff goes negative, paidPct clamps to 0', () => {
    // The real mistype case: original 500000 (LOAN_FACTS) but the live balance is
    // 596642 (> original). paidOff must be truthful (negative), the % bar clamped.
    const v = goalView(makeState({ homeLoan: { balance: 596642, asOf: null } }));
    expect(v.paidOff).toBe(-96642);
    expect(v.paidPct).toBe(0);
  });

  // WHIT-372: the shared, coherence-clamped "% gone" headline label. One source of truth for
  // both the Goals-hub card and the /mortgage hero — it must never read 100 while a balance is
  // still owing, but the raw paidPct (which the progress bar uses) stays untouched.
  it('a nearly-paid balance floors the label at 99 while the raw paidPct stays ~99.8', () => {
    // original 500000, balance 1000 -> paidPct 99.8 rounds to 100; the label clamps to 99 so it
    // never says "100% gone" next to "$1,000 to go". The bar value (paidPct) is NOT clamped.
    const v = goalView(makeState({ homeLoan: { balance: 1000, asOf: null } }));
    expect(v.paidPctLabel).toBe(99);
    expect(v.paidPct).toBeCloseTo(99.8, 5);
  });

  it('a truly $0 balance reads 100% gone', () => {
    const v = goalView(makeState({ homeLoan: { balance: 0, asOf: null } }));
    expect(v.paidPctLabel).toBe(100);
  });

  it('a residual-cents balance that rounds to $0 reads 100% gone (matches the "$0 to go" figure)', () => {
    // balance 0.43 shows as "$0 to go"; the label keys off the rounded balance, so it says 100 —
    // not the 99 the raw clamp alone would give — so figure and label agree.
    const v = goalView(makeState({ homeLoan: { balance: 0.43, asOf: null } }));
    expect(v.paidPctLabel).toBe(100);
  });

  // WHIT-378: the deposit target is the user's own number, not a hardcoded $90k.
  it('deposit target set but equity above it: depositPct clamps at 100, never over', () => {
    const facts = { ...LOAN_FACTS, depositTarget: 50000 };   // equity 116000 > target
    const v = goalView(makeState({ loanFacts: facts, homeLoan: { balance: 500000, asOf: null } }));
    expect(v.depositPct).toBe(100);
  });

  it('deposit target set but balance NULL: depositPct stays null (no equity to measure)', () => {
    const facts = { ...LOAN_FACTS, depositTarget: 100000 };
    const v = goalView(makeState({ loanFacts: facts, homeLoan: { balance: null, asOf: null } }));
    expect(v.usableEquity).toBeNull();
    expect(v.depositTarget).toBe(100000);
    expect(v.depositPct).toBeNull();
  });

  it('no deposit target: depositTarget + depositPct both null, no hardcoded $90k', () => {
    const v = goalView(makeState({ homeLoan: { balance: 500000, asOf: null } }));
    expect(v.usableEquity).toBe(116000);       // equity is real...
    expect(v.depositTarget).toBeNull();        // ...but there's no target
    expect(v.depositPct).toBeNull();           // so no % (never the old fake 90000-based figure)
  });
});

// ===== WHIT-378 (folded from depositTargetGaps.logic.test.ts) — adversarial GAP coverage for
// goalView's depositPct (QA, not implementer). Adds the boundaries the survivor skips: usableEquity
// EXACTLY 0 with a target set -> depositPct is 0 (not null, so the 0%-bar still renders), and a
// non-round ratio returned UNROUNDED by the selector (49.6, not 50 — the chip rounding lives in
// mortgage.tsx). No module-level const collisions; imports covered by the survivor.
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
});
