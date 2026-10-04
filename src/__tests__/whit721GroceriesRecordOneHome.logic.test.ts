// WHIT-721 — the Groceries sample lives once, in support/categories.ts. Every other test file imports or
// spreads it. The WHIT-718 / WHIT-719 guards pin the samples' values; this one catches a copy in any bucket.
import { describe, it, expect } from '@jest/globals';
import { findOffenders } from './support/sourceScan';
import { CATEGORIES_HOME, quoted } from './support/oneHomeGuard';

// Built from pieces so this file never matches its own scan.
const isGroceriesCopy = (line: string) =>
  line.includes(`id: ${quoted('groceries')}`) &&
  line.includes(`name: ${quoted('Groceries')}`) &&
  line.includes(`icon: ${quoted('cart')}`);

// These spell the samples out on purpose, to pin their values.
const VALUE_CHECKS = [
  'whit718CategorySamplesOneHome.logic.test.ts',
  'whit719GroceriesRecordQa.logic.test.ts',
  'whit719GroceriesTopOneHome.logic.test.ts',
  'whit719RemainingPairsOneHome.logic.test.ts',
];

describe('the shared Groceries sample has one home', () => {
  it('no other test file spells out a Groceries copy, in any field order', () => {
    expect(findOffenders(isGroceriesCopy, new Set([CATEGORIES_HOME, ...VALUE_CHECKS]))).toEqual([]);
  });
});
