// WHIT-727 / WHIT-745 — urgentFirst ordering rules (over budget first, nothing else lifts).
import { describe, it, expect } from '@jest/globals';
import { urgentFirst } from '../budgetOrder';
import { cat, budget } from './factory';
import { budgetRowsFor as rowsFor, rowIds as ids } from './support/budgetsTab';
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

  it.each([
    ['does not lift a row spent exactly to its budget', 100, ['groceries', 'dining']],
    ['lifts a row one cent over its budget', 100.01, ['dining', 'groceries']],
  ])('%s', (_case, diningPosted, order) => {
    const rows = rowsFor([groceries, dining], [
      budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: diningPosted, pending: 0 }),
    ]);
    expect(ids(urgentFirst(rows))).toEqual(order);
  });

  // An over grandchild lifts its whole three-level family above the rest, and all three rows
  // stay together with their depths.
  it('lifts a three-level family by its over grandchild, keeping it in one block', () => {
    const oat = cat({ id: 'oat', name: 'Oat lattes', parent: 'latte' });
    const rows = rowsFor([groceries, dining, coffee, latte, oat], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 85, pending: 0 }),
      budget({ id: 'coffee', budget: 300, posted: 100, pending: 0 }),
      budget({ id: 'latte', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'oat', budget: 20, posted: 30, pending: 0 }),
    ]);
    const ordered = urgentFirst(rows);
    expect(ids(ordered)).toEqual(['coffee', 'latte', 'oat', 'groceries', 'dining']);
    expect(ordered.map((r) => r.depth)).toEqual([0, 1, 2, 0, 0]);
  });

  // A corrupt parent loop (each names the other): every row is still listed exactly once, the
  // loop doesn't join the unrelated family before it, and an over loop row moves up.
  it('keeps a corrupt parent loop whole and separate from the family before it', () => {
    const loopA = cat({ id: 'loop_a', name: 'Loop A', parent: 'loop_b' });
    const loopB = cat({ id: 'loop_b', name: 'Loop B', parent: 'loop_a' });
    const rows = rowsFor([groceries, dining, loopA, loopB], [
      budget({ id: 'groceries', budget: 100, posted: 50, pending: 0 }),
      budget({ id: 'dining', budget: 100, posted: 85, pending: 0 }),
      budget({ id: 'loop_a', budget: 100, posted: 150, pending: 0 }),
      budget({ id: 'loop_b', budget: 100, posted: 10, pending: 0 }),
    ]);
    const ordered = urgentFirst(rows);
    expect(ordered).toHaveLength(rows.length);
    expect(new Set(ids(ordered))).toEqual(new Set(ids(rows)));
    expect(ids(ordered).slice(0, 2)).toEqual(['loop_a', 'loop_b']);
    expect(ids(ordered).slice(2)).toEqual(['groceries', 'dining']);
  });
});
