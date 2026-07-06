// Logic tests for the two pure selectors WHIT-90 calls out as untested:
// budgetEditInfo and goalView. Pure functions over a cast partial AppContext
// (makeState), like the sibling budget/format selector tests.
import { describe, it, expect } from '@jest/globals';
import { budgetEditInfo, goalView } from '../context';
import { makeState, cat, budget, EMPTY_LOAN_FACTS } from './factory';

describe('budgetEditInfo', () => {
  it('is in "set" mode with no existing budget, deriving avg from category.recent', () => {
    const s = makeState({ categories: [cat({ id: 'coffee', recent: 52 })], budgets: [] });
    const info = budgetEditInfo(s, 'coffee');
    expect(info.existing).toBeUndefined();
    expect(info.title).toBe('Set budget');
    expect(info.saveText).toBe('Add budget');
    expect(info.avg).toBe(52);
    expect(info.rec).toBe(52);            // recommendation = recent average
    expect(info.histBars).toHaveLength(6);
  });

  it('is in "edit" mode when a budget already exists', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee', recent: 52 })],
      budgets: [budget({ id: 'coffee', budget: 80 })],
    });
    const info = budgetEditInfo(s, 'coffee');
    expect(info.existing).toBeTruthy();
    expect(info.title).toBe('Edit budget');
    expect(info.saveText).toBe('Update budget');
  });

  it('reflects the pay-cycle word (fortnight for length 14)', () => {
    const s = makeState({ categories: [cat({ id: 'coffee' })], cycleLen: 14 });
    expect(budgetEditInfo(s, 'coffee').lastWord).toBe('fortnight');
  });

  it('frames a spend category as spend (recommendation on, spend history)', () => {
    const info = budgetEditInfo(makeState({ categories: [cat({ id: 'coffee', recent: 52 })] }), 'coffee');
    expect(info.isIncome).toBe(false);
    expect(info.hasRecommendation).toBe(true);
    expect(info.recommendCta).toBe('Use my average spend');
    expect(info.historyToggleLabel).toBe('View spending history');
    expect(info.avgLabel).toBe('$52');            // real spend figure shown
    expect(info.recPrompt).toBeUndefined();
  });

  it('frames an Income category as an earn-target: no recommendation, earnings copy, dashed stats (WHIT-169)', () => {
    // recent 4000 is a SPEND average — it must NOT be surfaced as an income floor.
    const s = makeState({ categories: [cat({ id: 'salary', bucket: 'Income', recent: 4000 })], budgets: [] });
    const info = budgetEditInfo(s, 'salary');
    expect(info.isIncome).toBe(true);
    expect(info.hasRecommendation).toBe(false);   // no trustworthy income basis
    expect(info.recPrompt).toBe('Set your income floor');
    expect(info.historyToggleLabel).toBe('View earning history');
    expect(info.recommendCta).toBe('Use my average income');
    expect(info.lastLabel).toBe('—');             // spend history dashed, not $ shown
    expect(info.avgLabel).toBe('—');
    expect(info.avgLabel).not.toBe('$4,000');     // the spend number is never presented as income
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
    expect(v.depositPct).toBe(0);         // null equity -> 0, never NaN
  });

  it('facts unset AND balance NULL: everything null, "—", no crash', () => {
    const v = goalView(makeState({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: null, asOf: null } }));
    expect(v.factsReady).toBe(false);
    expect(v.balanceKnown).toBe(false);
    expect(v.balanceLabel).toBe('—');
    expect(v.paidOff).toBeNull();
    expect(v.contribution).toBeNull();
    expect(v.usableEquity).toBeNull();
    expect(v.depositPct).toBe(0);
  });

  it('live balance ABOVE the original loan: paidOff goes negative, paidPct clamps to 0', () => {
    // The real mistype case: original 500000 (LOAN_FACTS) but the live balance is
    // 596642 (> original). paidOff must be truthful (negative), the % bar clamped.
    const v = goalView(makeState({ homeLoan: { balance: 596642, asOf: null } }));
    expect(v.paidOff).toBe(-96642);
    expect(v.paidPct).toBe(0);
  });

  it('usable equity computes to exactly 0 (balance == property×LVR): 0, not null, depositPct 0', () => {
    // homeValue 770000 × lvr 0.8 = 616000; a balance of 616000 -> equity exactly 0.
    const v = goalView(makeState({ homeLoan: { balance: 616000, asOf: null } }));
    expect(v.usableEquity).toBe(0);
    expect(v.depositPct).toBe(0);
  });
});
