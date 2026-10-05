// WHIT-745 — the Budgets tab lifts only over-budget families; a behind-pace row keeps category order.
import { it, expect } from '@jest/globals';
import { urgentFirst } from '../budgetOrder';
import { cat, budget } from './factory';
import { budgetRowsFor, rowIds } from './support/budgetsTab';
import { COFFEE, DINING, GROCERIES, LATTE, SALARY } from './support/categories';

const shopping = cat({ id: 'shopping', name: 'Shopping' });

it('lists over-budget families first, then the rest in category order, families whole and Earning last', () => {
  const rows = budgetRowsFor([GROCERIES, COFFEE, LATTE, shopping, DINING, SALARY], [
    budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
    budget({ id: 'coffee', budget: 200, posted: 100, pending: 0 }),
    budget({ id: 'latte', budget: 20, posted: 17, pending: 0 }),
    budget({ id: 'shopping', budget: 100, posted: 85, pending: 0 }),
    budget({ id: 'dining', budget: 100, posted: 150, pending: 0 }),
    budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
  ]);
  expect(rowIds(rows)).toEqual(['groceries', 'coffee', 'latte', 'shopping', 'dining', 'salary']);

  const ordered = urgentFirst(rows);
  expect(rowIds(ordered)).toEqual(['dining', 'groceries', 'coffee', 'latte', 'shopping', 'salary']);
  expect(ordered.map((r) => r.depth)).toEqual([0, 0, 0, 1, 0, 0]);
});
