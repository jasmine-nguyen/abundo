// WHIT-727 QA — urgentFirst edges the acceptance tests don't reach: a three-level family lifted
// by its grandchild, a corrupt parent loop (no row dropped or doubled), and the CSV export
// keeping category order (sign-off Q2). Expected orders are written by hand.
import { describe, it, expect } from '@jest/globals';
import { urgentFirst } from '../budgetOrder';
import { buildBudgetRows } from '../cycleExport';
import { cat, budget } from './factory';
import { budgetRowsFor as rowsFor, rowIds as ids } from './support/budgetsTab';
import { COFFEE as coffee, DINING as dining, GROCERIES as groceries, LATTE as latte } from './support/categories';

const oat = cat({ id: 'oat', name: 'Oat lattes', parent: 'latte' });

describe('urgentFirst — edges', () => {
  // [A1] (P0) an over grandchild lifts its whole three-level family above the rest (a behind-pace
  // row isn't lifted, WHIT-745), and all three rows stay together with their depths.
  it('lifts a three-level family by its over grandchild, keeping it in one block', () => {
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

  // [A2] (P1) a corrupt parent loop (each names the other): every row is still listed exactly
  // once, the loop doesn't join the unrelated family before it, and an over loop row moves up.
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

// [A3] (P1) sign-off Q2: the export keeps category order even when a later budget is over.
it('the budgets export keeps category order with an over-budget budget listed second', () => {
  const category = (id: string) => [coffee, dining].find((c) => c.id === id);
  const rows = buildBudgetRows([
    budget({ id: 'coffee', budget: 100, posted: 10, pending: 0 }),
    budget({ id: 'dining', budget: 100, posted: 150, pending: 0 }),
  ], category, false);
  expect(rows.slice(1).map((row) => row[1])).toEqual(['Cafes & Coffee', 'Dining']);
});
