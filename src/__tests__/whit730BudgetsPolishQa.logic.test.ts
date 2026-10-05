// WHIT-730 QA — edges of the Budgets polish rules: the over-plan boundaries on the detail screen,
// the "today" tick at exactly-on-budget, the `unspent` (slim row) rule for pending-only, a $0
// budget and a nested row.
// Halfway through a 14-day cycle, so a $100 budget's pace target is $50.
import { describe, it, expect } from '@jest/globals';
import { SALARY } from './support/categories';
import { budgetRowFor, budgetRowsFor, budgetDetailFor } from './support/budgetsTab';
import { budget, cat } from './factory';

describe('over plan (WHIT-730)', () => {
  it('[A2] within 50c of the plan is on track; pending counts toward being over plan', () => {
    expect(budgetDetailFor({ budget: 100, posted: 50.4 }).statusLabel).toBe('On track for payday');
    expect(budgetDetailFor({ budget: 100, posted: 49.6 }).statusLabel).toBe('On track for payday');
    expect(budgetDetailFor({ budget: 100, posted: 40, pending: 45 }).statusLabel).toBe('Over plan — ease up');
  });
});

describe('today tick (WHIT-730)', () => {
  it('[A4] spending exactly the whole budget is not over, but nothing is left so the tick hides (WHIT-741)', () => {
    const atLimit = budgetRowFor({ budget: 100, posted: 100, pending: 0 });
    expect(atLimit.over).toBe(false);
    expect(atLimit.showTarget).toBe(false);
    expect(budgetDetailFor({ budget: 100, posted: 100 }).showTarget).toBe(false);
  });

  it('[A5] one cent over hides the tick on both the row and the detail screen', () => {
    expect(budgetRowFor({ budget: 100, posted: 100.01, pending: 0 }).showTarget).toBe(false);
    expect(budgetDetailFor({ budget: 100, posted: 100.01 }).showTarget).toBe(false);
  });

  it('[A6] going over through pending alone hides the tick too', () => {
    expect(budgetRowFor({ budget: 100, posted: 60, pending: 50 }).showTarget).toBe(false);
  });

  it('[A7] an income budget keeps no tick on its row and keeps the tick on its detail screen', () => {
    const salary = budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 });
    expect(budgetRowsFor([SALARY], [salary])[0].showTarget).toBe(false);
    expect(budgetDetailFor({ budget: 5000, posted: 1000 }, undefined, SALARY).showTarget).toBe(true);
  });
});

describe('unspent / slim rows (WHIT-730)', () => {
  it('[A8] a pending-only charge counts as spent, so the row stays full', () => {
    expect(budgetRowFor({ budget: 100, posted: 0, pending: 5 }).unspent).toBe(false);
  });

  it('[A9] a $0 row is unspent and still carries its amount left for the slim layout', () => {
    const zero = budgetRowFor({ budget: 100, posted: 0, pending: 0 });
    expect(zero.unspent).toBe(true);
    expect(zero.over).toBe(false);
    expect(zero.remainLabel).toBe('left');
    expect(zero.remainAmount).toBe('$100');
  });

  it('[A10] a $0 budget with nothing spent is unspent, not over', () => {
    const empty = budgetRowFor({ budget: 0, posted: 0, pending: 0 });
    expect(empty.over).toBe(false);
    expect(empty.unspent).toBe(true);
  });

  it('[A11] a nested $0 sub-budget is unspent while its spending parent is not', () => {
    const parent = cat({ id: 'food', name: 'Food', parent: null });
    const child = cat({ id: 'latte', name: 'Lattes', parent: 'food' });
    const rows = budgetRowsFor([parent, child], [
      budget({ id: 'food', budget: 200, posted: 30, pending: 0 }),
      budget({ id: 'latte', budget: 50, posted: 0, pending: 0 }),
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.food.unspent).toBe(false);
    expect(byId.latte.unspent).toBe(true);
    expect(byId.latte.depth).toBe(1);
  });

  it('[A12] a $0 rollover row with past leftovers keeps its note for the slim layout', () => {
    const row = budgetRowFor({ budget: 100, posted: 0, pending: 0, rollover: true, carryover: 40 });
    expect(row.unspent).toBe(true);
    expect(row.note).toBe('Includes $40 past leftovers');
  });
});
