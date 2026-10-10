// WHIT-525 — adversarial gap tests for the budgetDetail `contributesToBudget` filter.
// The new `.filter(contributesToBudget)` line (context.tsx) checks BOTH
// `counts_to_budget` AND `!budget_excluded`. The implementer's tests (budget.logic.test.ts)
// cover the `budget_excluded` arm; these pin the `counts_to_budget` arm and mixed-state
// boundaries that would silently regress if the filter line is reverted.
import { describe, it, expect } from '@jest/globals';
import { budgetDetail, contributesToBudget } from '../context';
import { makeState, cat, txn, budget } from './factory';

describe('budgetDetail — contributesToBudget filter gaps (WHIT-525)', () => {
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
  it.each([
    { name: '[A10a] counts_to_budget: true, budget_excluded: undefined → true', fields: { counts_to_budget: true }, expected: true },
    { name: '[A10b] counts_to_budget: true, budget_excluded: false → true', fields: { counts_to_budget: true, budget_excluded: false }, expected: true },
    { name: '[A10c] counts_to_budget: true, budget_excluded: true → false', fields: { counts_to_budget: true, budget_excluded: true }, expected: false },
    { name: '[A10d] counts_to_budget: false, budget_excluded: undefined → false', fields: { counts_to_budget: false }, expected: false },
    { name: '[A10e] counts_to_budget: undefined (missing) → false', fields: { counts_to_budget: undefined as unknown as boolean }, expected: false },
  ])('$name', ({ fields, expected }) => {
    expect(contributesToBudget({ ...txn(), ...fields })).toBe(expected);
  });
});
