// WHIT-298 — the `excluded` flag on transactionView: "this charge doesn't count toward
// budgets", the single source of truth behind the row's "Not in budget" tag. It fires for
// BOTH the bank's auto-exclusion (counts_to_budget === false) and the user's own override
// (budget_excluded === true), mirroring contributesToBudget.
import { describe, it, expect } from '@jest/globals';
import { transactionView } from '../context';
import { makeState, cat, txn } from './factory';

const s = () => makeState({ categories: [cat({ id: 'groceries', name: 'Groceries' })] });

describe('transactionView.excluded (WHIT-298)', () => {
  it('is true when the bank auto-excluded the charge (counts_to_budget === false)', () => {
    expect(transactionView(s(), txn({ counts_to_budget: false })).excluded).toBe(true);
  });

  it('is true when the user manually excluded it (budget_excluded === true)', () => {
    expect(transactionView(s(), txn({ counts_to_budget: true, budget_excluded: true })).excluded).toBe(true);
  });

  // Fail-on-revert anchor: a normal counted charge must NOT be tagged. Reverting the
  // `excluded: !contributesToBudget(t)` line flips this to true and breaks here.
  it('is false for a normal counted charge', () => {
    expect(transactionView(s(), txn({ counts_to_budget: true })).excluded).toBe(false);
  });
});
