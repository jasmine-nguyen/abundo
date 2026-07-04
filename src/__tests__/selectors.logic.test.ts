// Logic tests for the two pure selectors WHIT-90 calls out as untested:
// budgetEditInfo and goalView. Pure functions over a cast partial AppContext
// (makeState), like the sibling budget/format selector tests.
import { describe, it, expect } from '@jest/globals';
import { budgetEditInfo, goalView } from '../context';
import { makeState, cat, budget } from './factory';

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
});

describe('goalView', () => {
  it('computes paid-off, usable equity, and contribution from the goal', () => {
    const v = goalView(makeState());
    // GOAL: original 500000, balance 432900, homeValue 640000, baseRepay 1240, extra 200
    expect(v.paidOff).toBe(67100);                       // 500000 - 432900
    expect(v.paidPct).toBeCloseTo((67100 / 500000) * 100, 5);
    expect(v.usableEquity).toBe(79100);                  // round(640000*0.8) - 432900
    expect(v.contribution).toBe(1440);                   // baseRepay + extra
  });
});
