// WHIT-314: budgetViews now also returns `totEarnedBudget` — the sum of income earn-targets,
// with the SAME top-most-row de-dup as the spend total (totBudget), for the Insights budgeted
// overlay. These lock the income accumulator without disturbing the existing spend totals.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { makeState, cat, budget } from './factory';

describe('budgetViews — totEarnedBudget (WHIT-314)', () => {
  it('sums income earn-targets and keeps them out of the spend totals', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee', bucket: 'Lifestyle' }), cat({ id: 'salary', bucket: 'Income' })],
      budgets: [
        budget({ id: 'coffee', budget: 400, posted: 100, pending: 0 }),
        budget({ id: 'salary', budget: 5000, posted: 4000, pending: 0 }),
      ],
    });
    const { totBudget, totEarnedBudget } = budgetViews(s);
    expect(totEarnedBudget).toBe(5000); // income target
    expect(totBudget).toBe(400);        // spend target only — income never leaks in
  });

  it('de-dups a nested income budget (counts only the top-most income row per family)', () => {
    const s = makeState({
      categories: [
        cat({ id: 'salary', bucket: 'Income' }),
        cat({ id: 'bonus', bucket: 'Income', parent: 'salary' }), // budgeted child of a budgeted income parent
      ],
      budgets: [
        budget({ id: 'salary', budget: 5000, posted: 0, pending: 0 }),
        budget({ id: 'bonus', budget: 800, posted: 0, pending: 0 }),
      ],
    });
    // The parent's rollup already covers the child, so only the depth-0 parent counts.
    expect(budgetViews(s).totEarnedBudget).toBe(5000);
  });

  it('excludes Savings budgets and is 0 with no income targets', () => {
    const spendOnly = makeState({
      categories: [cat({ id: 'coffee', bucket: 'Lifestyle' }), cat({ id: 'nest', bucket: 'Savings' })],
      budgets: [budget({ id: 'coffee', budget: 400 }), budget({ id: 'nest', budget: 1000 })],
    });
    expect(budgetViews(spendOnly).totEarnedBudget).toBe(0);
    expect(budgetViews(makeState({ budgets: [] })).totEarnedBudget).toBe(0);
  });
});
