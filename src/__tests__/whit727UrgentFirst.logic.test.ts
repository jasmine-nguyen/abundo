// WHIT-727 — the Budgets tab lists urgent spending families first: over budget → over plan →
// the rest, each family (a parent and its sub-budgets) moving as one block. Earning stays last.
import { it, expect } from '@jest/globals';
import { budgetViews } from '../context';
import { urgentFirst } from '../budgetOrder';
import { makeState, cat, budget } from './factory';

const groceries = cat({ id: 'groceries', name: 'Groceries', bucket: 'Living' });
const dining = cat({ id: 'dining', name: 'Dining' });
const coffee = cat();
const latte = cat({ id: 'latte', name: 'Lattes', parent: 'coffee' });
const shopping = cat({ id: 'shopping', name: 'Shopping' });
const salary = cat({ id: 'salary', name: 'Salary', bucket: 'Income' });

it('orders spending families over → behind → on pace, keeping subs under their parent and earning last', () => {
  // Halfway through a 14-day cycle, so a $100 budget's pace is $50.
  const { rows } = budgetViews(
    makeState({
      categories: [groceries, dining, coffee, latte, shopping, salary],
      cycleLen: 14,
      daysLeft: 7,
      budgets: [
        budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }), // earning
        budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }), // on pace
        budget({ id: 'dining', budget: 100, posted: 70, pending: 0 }), // over plan
        budget({ id: 'coffee', budget: 200, posted: 100, pending: 0 }), // parent on pace…
        budget({ id: 'latte', budget: 20, posted: 30, pending: 0 }), // …its sub over budget
        budget({ id: 'shopping', budget: 100, posted: 150, pending: 0 }), // over budget
      ],
    }),
  );

  const ordered = urgentFirst(rows);

  expect(ordered.map((r) => r.id)).toEqual(['coffee', 'latte', 'shopping', 'dining', 'groceries', 'salary']);
  expect(ordered.map((r) => r.depth)).toEqual([0, 1, 0, 0, 0, 0]);
  expect(urgentFirst([])).toEqual([]);
});
