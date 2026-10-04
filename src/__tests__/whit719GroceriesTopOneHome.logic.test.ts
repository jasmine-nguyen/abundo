// WHIT-719 slice 1 — the top-level groceries row the transactions and filing screens seed (with
// and without its colour) lives once, in support/categories.ts. Every other test file imports it.
import { describe, it, expect } from '@jest/globals';
import { GROCERIES_TOP, GROCERIES_TOP_RECORD } from './support/categories';
import { findOffenders } from './support/sourceScan';

const HOME = 'support/categories.ts';

// Built from pieces so this file never matches its own scan.
const q = (text: string) => `'${text}'`;
const COPIES = [
  `icon: ${q('cart')}, color: ${q('#7FD49B')}, parent: null`,
  `name: ${q('Groceries')}, icon: ${q('cart')}, bucket: ${q('Living')}, parent: null`,
];

describe('the shared top-level groceries sample has one home', () => {
  it('support/categories exports the groceries row with and without its colour, frozen', () => {
    expect(GROCERIES_TOP_RECORD).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null });
    expect(GROCERIES_TOP).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null });
    expect(Object.isFrozen(GROCERIES_TOP_RECORD)).toBe(true);
    expect(Object.isFrozen(GROCERIES_TOP)).toBe(true);
  });

  it('no other test file spells out a copy of the groceries row', () => {
    const offenders = findOffenders(
      (line) => COPIES.some((copy) => line.includes(copy)),
      new Set([HOME, 'whit719GroceriesTopOneHome.logic.test.ts']),
    );
    expect(offenders).toEqual([]);
  });
});
