// WHIT-296 — [A-C1] contributesToBudget: the single new exported gate the
// uncategorized tab/count and the "apply to every {merchant}" sweep all share
// (context.tsx:1951). The implementer's categorize.logic.test.ts exercises it
// INDIRECTLY through countUncategorized / transactionGroups; this pins the raw
// truth table directly so a change to the &&/! logic can't slip through.
import { describe, it, expect } from '@jest/globals';
import { contributesToBudget } from '../context';
import { txn } from './factory';

describe('contributesToBudget', () => {
  it('counts a bank-counting charge with no override', () => {
    expect(contributesToBudget(txn({ counts_to_budget: true }))).toBe(true);
  });

  it('drops a bank-counting charge the user excluded (mark as transfer)', () => {
    // Fail-on-revert anchor: revert the `&& !t.budget_excluded` clause and this flips.
    expect(contributesToBudget(txn({ counts_to_budget: true, budget_excluded: true }))).toBe(false);
  });

  it('treats an absent override as not-excluded (undefined = counts)', () => {
    expect(contributesToBudget(txn({ counts_to_budget: true, budget_excluded: undefined }))).toBe(true);
  });

  it('treats an explicit false override as not-excluded', () => {
    expect(contributesToBudget(txn({ counts_to_budget: true, budget_excluded: false }))).toBe(true);
  });

  it('never counts a charge the bank already excludes, override or not', () => {
    expect(contributesToBudget(txn({ counts_to_budget: false }))).toBe(false);
    expect(contributesToBudget(txn({ counts_to_budget: false, budget_excluded: false }))).toBe(false);
  });
});
