// WHIT-296 — contributesToBudget: the single gate the uncategorized tab/count and the "apply to
// every {merchant}" sweep all share. The raw truth table, so a change to the &&/! logic can't slip
// through. toBe is strict: an omitted counts_to_budget must return a real `false` (WHIT-328).
import { describe, it, expect } from '@jest/globals';
import { contributesToBudget } from '../context';
import type { Transaction } from '../types';
import { txn } from './factory';

describe('contributesToBudget', () => {
  it.each<[string, Partial<Transaction>, boolean]>([
    ['a bank-counting charge with no override counts', { counts_to_budget: true }, true],
    ['a bank-counting charge the user excluded is dropped', { counts_to_budget: true, budget_excluded: true }, false],
    ['an absent override is not-excluded', { counts_to_budget: true, budget_excluded: undefined }, true],
    ['an explicit false override is not-excluded', { counts_to_budget: true, budget_excluded: false }, true],
    ['a charge the bank already excludes never counts', { counts_to_budget: false }, false],
    ['a bank-excluded charge with a false override never counts', { counts_to_budget: false, budget_excluded: false }, false],
    ['an undefined counts_to_budget is a strict false', { counts_to_budget: undefined }, false],
  ])('%s', (_case, fields, expected) => {
    expect(contributesToBudget(txn(fields))).toBe(expected);
  });
});
