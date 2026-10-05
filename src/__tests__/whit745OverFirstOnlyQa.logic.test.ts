// WHIT-745 QA — over-first-only edges: exactly-at-limit, a cent over, pending tipping a row over,
// a rollover buffer keeping a past-target row under, and a behind-pace parent lifted only by its over sub.
import { it, expect } from '@jest/globals';
import { urgentFirst } from '../budgetOrder';
import { cat, budget } from './factory';
import { budgetRowsFor as rowsFor, rowIds as ids } from './support/budgetsTab';
import { COFFEE as coffee, DINING as dining, GROCERIES as groceries, LATTE as latte } from './support/categories';

const shopping = cat({ id: 'shopping', name: 'Shopping' });

// [A1] (P0) a budget used to the exact cent is not over, so it keeps its category place.
it('does not lift a row spent exactly to its budget', () => {
  const rows = rowsFor([groceries, dining], [
    budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
    budget({ id: 'dining', budget: 100, posted: 100, pending: 0 }),
  ]);
  expect(rows.find((r) => r.id === 'dining')!.over).toBe(false);
  expect(ids(urgentFirst(rows))).toEqual(['groceries', 'dining']);
});

// [A2] (P0) one cent over budget is over and moves to the top.
it('lifts a row one cent over its budget', () => {
  const rows = rowsFor([groceries, dining], [
    budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
    budget({ id: 'dining', budget: 100, posted: 100.01, pending: 0 }),
  ]);
  expect(ids(urgentFirst(rows))).toEqual(['dining', 'groceries']);
});

// [A3] (P1) pending charges count: posted under budget plus pending over it lifts the row.
it('lifts a row that pending charges push over budget', () => {
  const rows = rowsFor([groceries, dining], [
    budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
    budget({ id: 'dining', budget: 100, posted: 90, pending: 20 }),
  ]);
  expect(ids(urgentFirst(rows))).toEqual(['dining', 'groceries']);
});

// [A4] (P1) a rollover buffer: spent past the base target but within what's available is not over.
it('does not lift a rollover row spent past its target but within its buffer', () => {
  const rows = rowsFor([groceries, dining], [
    budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
    budget({ id: 'dining', budget: 100, posted: 130, pending: 0, rollover: true, carryover: 50 }),
  ]);
  expect(ids(urgentFirst(rows))).toEqual(['groceries', 'dining']);
});

// [A5] (P0) a behind-pace parent is lifted only because its sub is over; another behind-pace
// family stays in category order behind an on-pace one.
it('lifts a family by its over sub, not by its behind-pace parent', () => {
  const rows = rowsFor([groceries, shopping, coffee, latte], [
    budget({ id: 'groceries', budget: 100, posted: 40, pending: 0 }),
    budget({ id: 'shopping', budget: 100, posted: 90, pending: 0 }),
    budget({ id: 'coffee', budget: 200, posted: 180, pending: 0 }),
    budget({ id: 'latte', budget: 20, posted: 25, pending: 0 }),
  ]);
  const ordered = urgentFirst(rows);
  expect(ids(ordered)).toEqual(['coffee', 'latte', 'groceries', 'shopping']);
  expect(ordered.map((r) => r.depth)).toEqual([0, 1, 0, 0]);
});
