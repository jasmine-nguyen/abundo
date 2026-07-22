// WHIT-314: selectBudgetedTotals — the {budgetedEarned, budgetedSpent} pair the Insights
// budgeted overlay reads, derived THROUGH budgetViews so it inherits the same de-dup. These
// pin the income/spend split and the empty case.
import { describe, it, expect } from '@jest/globals';
import { selectBudgetedTotals } from '../queries';
import { type Budget, type Category } from '../context';

const CATS: Category[] = [
  { id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 0 },
  { id: 'rent', name: 'Rent', icon: 'home', color: '#7aa2f7', bucket: 'Living', recent: 0 },
  { id: 'salary', name: 'Salary', icon: 'cash', color: '#2ac3de', bucket: 'Income', recent: 0 },
];
const category = (id: string) => CATS.find((c) => c.id === id);
const b = (id: string, amount: number): Budget => ({ id, budget: amount, posted: 0, pending: 0 });

describe('selectBudgetedTotals (WHIT-314)', () => {
  it('splits budgeted income from budgeted spend', () => {
    const totals = selectBudgetedTotals([b('coffee', 400), b('rent', 2000), b('salary', 5000)], category);
    expect(totals).toEqual({ budgetedEarned: 5000, budgetedSpent: 2400 });
  });

  it('handles income-only and spend-only', () => {
    expect(selectBudgetedTotals([b('salary', 5000)], category)).toEqual({ budgetedEarned: 5000, budgetedSpent: 0 });
    expect(selectBudgetedTotals([b('coffee', 400)], category)).toEqual({ budgetedEarned: 0, budgetedSpent: 400 });
  });

  it('is zeroed when no budgets are set', () => {
    expect(selectBudgetedTotals([], category)).toEqual({ budgetedEarned: 0, budgetedSpent: 0 });
  });
});
