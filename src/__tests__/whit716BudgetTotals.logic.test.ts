// WHIT-716 — the Budgets top card names pending spend, so budgetViews' totals carry it:
// pending summed once per family (top-most budgeted spend row), never Income or Savings.
import { describe, it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { makeState, cat, budget } from './factory';

describe('budgetViews totPending (WHIT-716)', () => {
  it('sums pending across top-level spending rows only — not Income, Savings or a nested budgeted sub', () => {
    const s = makeState({
      categories: [
        cat({ id: 'car', name: 'Car', bucket: 'Living', parent: null }),
        cat({ id: 'parking', name: 'Parking', bucket: 'Living', parent: 'car' }),
        cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle' }),
        cat({ id: 'salary', name: 'Salary', bucket: 'Income' }),
        cat({ id: 'rainy', name: 'Rainy Day', bucket: 'Savings' }),
      ],
      budgets: [
        budget({ id: 'car', budget: 200, posted: 60, pending: 15 }),
        budget({ id: 'parking', budget: 50, posted: 20, pending: 10 }),
        budget({ id: 'coffee', budget: 100, posted: 40, pending: 5.25 }),
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 300 }),
        budget({ id: 'rainy', budget: 300, posted: 100, pending: 70 }),
      ],
      cycleLen: 14, daysLeft: 7,
    });
    expect(budgetViews(s).totPending).toBe(20.25);
  });
});
