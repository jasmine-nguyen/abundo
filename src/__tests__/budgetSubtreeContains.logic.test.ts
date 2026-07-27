// WHIT-348 unit edges for budgetSubtreeContains — the client mirror of the server's subtree_ids.
// The full cross-product parity vs the server rule lives in budgetSubtreeParity.logic.test.ts;
// this file pins the individual branches with a hand-built tree so a failure names the exact case.
import { describe, it, expect } from '@jest/globals';
import { budgetSubtreeContains } from '../context';
import type { Category } from '../context';

// Minimal Category; only id/parent/bucket drive the rule.
const cat = (id: string, parent: string | null, bucket: string): Category =>
  ({ id, name: id, icon: 'q', color: '#fff', bucket: bucket as Category['bucket'], recent: 0, parent });

// car(Living) → parking(Living); car → odd(Lifestyle) → deep(Living); car → nest(Savings).
// income(Lifestyle) is unrelated. loopA↔loopB is a corrupt two-node cycle (both Living).
const CATS: Category[] = [
  cat('car', null, 'Living'),
  cat('parking', 'car', 'Living'),
  cat('odd', 'car', 'Lifestyle'),
  cat('deep', 'odd', 'Living'),
  cat('nest', 'car', 'Savings'),
  cat('income', null, 'Lifestyle'),
  cat('loopA', 'loopB', 'Living'),
  cat('loopB', 'loopA', 'Living'),
];

describe('budgetSubtreeContains (WHIT-348)', () => {
  it('the root is always in its own subtree', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'car')).toBe(true);
  });

  it('a same-bucket direct child is contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'parking')).toBe(true);
  });

  it('a same-bucket descendant UNDER a cross-bucket intermediate is contained (endpoints only)', () => {
    // car(Living) → odd(Lifestyle) → deep(Living): the walk passes through the Lifestyle node,
    // and deep is kept because deep and car share the Living bucket.
    expect(budgetSubtreeContains(CATS, 'car', 'deep')).toBe(true);
  });

  it('a cross-bucket direct child is NOT contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'odd')).toBe(false);
  });

  it('a Savings child of a Living budget is NOT contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'nest')).toBe(false);
  });

  it('an ancestor is not contained by its own child (walk is downward-only)', () => {
    expect(budgetSubtreeContains(CATS, 'parking', 'car')).toBe(false);
  });

  it('an unrelated top-level category is not contained', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'income')).toBe(false);
  });

  it('an unknown categoryId is not contained (unless it equals the budget id)', () => {
    expect(budgetSubtreeContains(CATS, 'car', 'ghost')).toBe(false);
    expect(budgetSubtreeContains(CATS, 'ghost', 'ghost')).toBe(true); // root-equality short-circuit
  });

  it('a corrupt parent cycle terminates and returns a boolean (no hang)', () => {
    expect(budgetSubtreeContains(CATS, 'loopA', 'loopB')).toBe(true);   // loopB → loopA reaches the root
    expect(budgetSubtreeContains(CATS, 'car', 'loopA')).toBe(false);    // the cycle is unrelated to car
  });
});
