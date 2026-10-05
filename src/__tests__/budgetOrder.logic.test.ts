// WHIT-727 / WHIT-745 — urgentFirst ordering rules (over budget first, nothing else lifts) and the behindPace flag.
import { describe, it, expect } from '@jest/globals';
import { urgentFirst } from '../budgetOrder';
import { cat, budget } from './factory';
import { budgetRowFor, budgetRowsFor as rowsFor, rowIds as ids } from './support/budgetsTab';
import { COFFEE as coffee, DINING as dining, GROCERIES as groceries, LATTE as latte, SALARY as salary } from './support/categories';

const shopping = cat({ id: 'shopping', name: 'Shopping' });
const bonus = cat({ id: 'bonus', name: 'Bonus', bucket: 'Income', parent: 'salary' });

describe('urgentFirst', () => {
  it('keeps two over-budget rows in their input order', () => {
    const rows = rowsFor([groceries, dining, shopping], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 150, pending: 0 }),
      budget({ id: 'shopping', budget: 100, posted: 120, pending: 0 }),
    ]);
    expect(ids(urgentFirst(rows))).toEqual(['dining', 'shopping', 'groceries']);
  });

  it('does not lift a family whose sub is only behind pace; sub stays under its parent', () => {
    const rows = rowsFor([groceries, coffee, latte], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'coffee', budget: 200, posted: 100, pending: 0 }),
      budget({ id: 'latte', budget: 20, posted: 17, pending: 0 }),
    ]);
    const ordered = urgentFirst(rows);
    expect(ids(ordered)).toEqual(['groceries', 'coffee', 'latte']);
    expect(ordered.map((r) => r.depth)).toEqual([0, 0, 1]);
  });

  it('leaves a nested earning family last and in order', () => {
    const rows = rowsFor([salary, bonus, groceries, dining], [
      budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 }),
      budget({ id: 'bonus', budget: 500, posted: 0, pending: 0 }),
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 150, pending: 0 }),
    ]);
    expect(ids(urgentFirst(rows))).toEqual(['dining', 'groceries', 'salary', 'bonus']);
  });

  it('keeps the budgetViews order when every row is on pace', () => {
    const rows = rowsFor([groceries, dining, shopping], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'shopping', budget: 100, posted: 50, pending: 0 }),
    ]);
    expect(ids(urgentFirst(rows))).toEqual(['groceries', 'dining', 'shopping']);
  });
});

describe('behindPace', () => {
  it('is true for a row past its pace line', () => {
    const row = budgetRowFor({ budget: 100, posted: 85, pending: 0 });
    expect(row.behindPace).toBe(true);
  });

  it('is false for an on-pace, over-budget or income row', () => {
    expect(budgetRowFor({ budget: 100, posted: 50, pending: 0 }).behindPace).toBe(false);
    expect(budgetRowFor({ budget: 100, posted: 150, pending: 0 }).behindPace).toBe(false);
    expect(budgetRowFor({ id: 'salary', budget: 5000, posted: 0, pending: 0 }, salary).behindPace).toBe(false);
  });
});
