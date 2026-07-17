// WHIT-298 — adversarial GAP tests for transactionView.excluded, the single source of truth
// behind the row's "Not in budget" tag. The implementer's transactionViewExcluded.logic.test.ts
// covers the three base cases (bank-false / user-excluded / normal). These lock the COMBINATIONS
// the tag must survive: bank+user together, income, uncategorized, pending, and the server
// omitting counts_to_budget (undefined). Each asserts against the real exported transactionView.
import { describe, it, expect } from '@jest/globals';
import { transactionView } from '../context';
import { makeState, cat, txn } from './factory';

const s = () => makeState({ categories: [cat({ id: 'groceries', name: 'Groceries' })] });

describe('transactionView.excluded — edge combinations (WHIT-298)', () => {
  // [A-combo] bank AND user exclusion set together — still one excluded=true, never a double state.
  it('is true when BOTH counts_to_budget is false AND budget_excluded is true', () => {
    expect(transactionView(s(), txn({ counts_to_budget: false, budget_excluded: true })).excluded).toBe(true);
  });

  // [A-income] an income row the bank flags as not-counting still tags excluded; income keeps its label.
  it('tags an EXCLUDED income row and keeps categoryLabel "Income"', () => {
    const v = transactionView(s(), txn({ category: 'income', amount: 2500, counts_to_budget: false }));
    expect(v.excluded).toBe(true);
    expect(v.categoryLabel).toBe('Income');
  });

  // [A-income-normal] a normal counted income row is NOT tagged (guards over-tagging all income).
  it('does NOT tag a normal counted income row', () => {
    expect(transactionView(s(), txn({ category: 'income', amount: 2500, counts_to_budget: true })).excluded).toBe(false);
  });

  // [A-uncat] excluded + uncategorized are independent axes: the row is both tappable AND tagged.
  it('an excluded UNCATEGORIZED row is still tappable and tagged excluded', () => {
    const v = transactionView(s(), txn({ category: null, counts_to_budget: false }));
    expect(v.excluded).toBe(true);
    expect(v.tappable).toBe(true);
    expect(v.categoryLabel).toBe('Uncategorized');
  });

  // [A-pending] excluded + pending coexist (both pills can show on one row).
  it('an excluded PENDING row reports both excluded and isPending', () => {
    const v = transactionView(s(), txn({ category: 'groceries', status: 'pending', counts_to_budget: false }));
    expect(v.excluded).toBe(true);
    expect(v.isPending).toBe(true);
  });

  // [A-undef] the server omits counts_to_budget → contributesToBudget short-circuits falsy →
  // excluded is TRUE. Documents current behaviour; see critique: the DETAIL screen diverges here.
  it('treats an omitted counts_to_budget (undefined) as excluded=true', () => {
    expect(transactionView(s(), txn({ counts_to_budget: undefined })).excluded).toBe(true);
  });
});
