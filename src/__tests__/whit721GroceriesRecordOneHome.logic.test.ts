// WHIT-721 — the Groceries sample the screen tests seed lives once, in support/categories.ts, as
// GROCERIES_RECORD (the raw server record). Every other test file imports or spreads it.
import { describe, it, expect } from '@jest/globals';
import { GROCERIES, GROCERIES_RECORD } from './support/categories';
import { findOffenders } from './support/sourceScan';

// Built from pieces so this file never matches its own scan.
const q = (text: string) => `'${text}'`;
const isGroceriesCopy = (line: string) =>
  line.includes(`id: ${q('groceries')}`) &&
  line.includes(`name: ${q('Groceries')}`) &&
  line.includes(`icon: ${q('cart')}`) &&
  line.includes(`bucket: ${q('Living')}`);

describe('the shared Groceries sample has one home', () => {
  it('support/categories exports the raw Groceries record, and GROCERIES keeps its value', () => {
    expect(GROCERIES_RECORD).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart' });
    expect(Object.isFrozen(GROCERIES_RECORD)).toBe(true);
    expect(GROCERIES).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 });
    expect(Object.isFrozen(GROCERIES)).toBe(true);
  });

  it('no other test file spells out a Groceries copy, in any field order', () => {
    // The WHIT-718 guard pins GROCERIES' full value on purpose, like this file does.
    const allowed = new Set(['support/categories.ts', 'whit718CategorySamplesOneHome.logic.test.ts', 'whit721GroceriesRecordOneHome.logic.test.ts']);
    const offenders = findOffenders(isGroceriesCopy, allowed);
    expect(offenders).toEqual([]);
  });
});
