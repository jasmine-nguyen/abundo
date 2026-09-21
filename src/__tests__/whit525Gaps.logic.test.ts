// WHIT-525 — adversarial gap tests for the budgetDetail `contributesToBudget` filter.
// The new `.filter(contributesToBudget)` line (context.tsx) checks BOTH
// `counts_to_budget` AND `!budget_excluded`. The implementer's tests (budget.logic.test.ts)
// cover the `budget_excluded` arm; these pin the `counts_to_budget` arm and mixed-state
// boundaries that would silently regress if the filter line is reverted.
import { describe, it, expect } from '@jest/globals';
import { budgetDetail, contributesToBudget } from '../context';
import { makeState, cat, txn, budget } from './factory';

describe('budgetDetail — contributesToBudget filter gaps (WHIT-525)', () => {
  it('[A6] filters out a counts_to_budget: false row from relItems', () => {
    const bd = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [
        txn({ transaction_id: 'normal', category: 'coffee' }),
        txn({ transaction_id: 'transfer', category: 'coffee', counts_to_budget: false }),
      ],
    }), 'coffee')!;
    expect(bd.relItems.map((t) => t.transaction_id)).toEqual(['normal']);
  });

  it('[A7] filters out both budget_excluded and counts_to_budget: false rows, keeping only contributing rows', () => {
    const bd = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [
        txn({ transaction_id: 'ok', category: 'coffee' }),
        txn({ transaction_id: 'excluded', category: 'coffee', budget_excluded: true }),
        txn({ transaction_id: 'transfer', category: 'coffee', counts_to_budget: false }),
      ],
    }), 'coffee')!;
    expect(bd.relItems.map((t) => t.transaction_id)).toEqual(['ok']);
    expect(bd.relEmpty).toBe(false);
  });

  it('[A8] relEmpty is true when all rows are non-contributing (counts_to_budget: false)', () => {
    const bd = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [
        txn({ transaction_id: 'only', category: 'coffee', counts_to_budget: false }),
      ],
    }), 'coffee')!;
    expect(bd.relItems).toEqual([]);
    expect(bd.relEmpty).toBe(true);
  });

  it('[A9] a pending contributing row passes through the filter', () => {
    const bd = budgetDetail(makeState({
      categories: [cat()], budgets: [budget()], cycleLen: 14, daysLeft: 7,
      transactions: [
        txn({ transaction_id: 'pend', category: 'coffee', status: 'pending', counts_to_budget: true }),
      ],
    }), 'coffee')!;
    expect(bd.relItems.map((t) => t.transaction_id)).toEqual(['pend']);
  });
});

describe('contributesToBudget — truth table (WHIT-525)', () => {
  it('[A10a] counts_to_budget: true, budget_excluded: undefined → true', () => {
    expect(contributesToBudget(txn({ counts_to_budget: true }))).toBe(true);
  });
  it('[A10b] counts_to_budget: true, budget_excluded: false → true', () => {
    expect(contributesToBudget(txn({ counts_to_budget: true, budget_excluded: false }))).toBe(true);
  });
  it('[A10c] counts_to_budget: true, budget_excluded: true → false', () => {
    expect(contributesToBudget(txn({ counts_to_budget: true, budget_excluded: true }))).toBe(false);
  });
  it('[A10d] counts_to_budget: false, budget_excluded: undefined → false', () => {
    expect(contributesToBudget(txn({ counts_to_budget: false }))).toBe(false);
  });
  it('[A10e] counts_to_budget: undefined (missing) → false', () => {
    const t = { ...txn(), counts_to_budget: undefined as unknown as boolean };
    expect(contributesToBudget(t)).toBe(false);
  });
});
