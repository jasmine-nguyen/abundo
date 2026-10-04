// WHIT-719 slice 1 — the top-level groceries row the transactions and filing screens seed (with
// and without its colour) lives once, in support/categories.ts. Every other test file imports it.
import { describe, it, expect } from '@jest/globals';
import { GROCERIES_TOP, GROCERIES_TOP_RECORD } from './support/categories';
import { findCopies, quoted } from './support/oneHomeGuard';

const COPIES = [
  `icon: ${quoted('cart')}, color: ${quoted('#7FD49B')}, parent: null`,
  `name: ${quoted('Groceries')}, icon: ${quoted('cart')}, bucket: ${quoted('Living')}, parent: null`,
];

describe('the shared top-level groceries sample has one home', () => {
  it('support/categories exports the groceries row with and without its colour, frozen', () => {
    expect(GROCERIES_TOP_RECORD).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null });
    expect(GROCERIES_TOP).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null });
    expect(Object.isFrozen(GROCERIES_TOP_RECORD)).toBe(true);
    expect(Object.isFrozen(GROCERIES_TOP)).toBe(true);
  });

  it('no other test file spells out a copy of the groceries row', () => {
    expect(findCopies(COPIES, ['whit719GroceriesTopOneHome.logic.test.ts'])).toEqual([]);
  });
});
