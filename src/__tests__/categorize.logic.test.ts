// Categorization selectors: isUncategorized / countUncategorized (drive the
// "uncategorized" tab + badge) and transactionView (drives every row's label,
// colour, pending flag, and tappability). Single sources of truth, so a
// regression here would silently mislabel money.
import { describe, it, expect } from '@jest/globals';
import { isUncategorized, countUncategorized, transactionView, transactionGroups } from '../context';
import { C } from '../theme';
import { makeState, cat, txn } from './factory';

const state = () => makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })] });

describe('isUncategorized', () => {
  it('is true when category is null', () => {
    expect(isUncategorized(state(), txn({ category: null }))).toBe(true);
  });

  it('is true when category points at an id not in the taxonomy', () => {
    expect(isUncategorized(state(), txn({ category: 'raw_bank_code' }))).toBe(true);
  });

  it('is false for a known category', () => {
    expect(isUncategorized(state(), txn({ category: 'coffee' }))).toBe(false);
  });

  it("treats 'income' as categorized, not uncategorized", () => {
    expect(isUncategorized(state(), txn({ category: 'income' }))).toBe(false);
  });
});

describe('countUncategorized', () => {
  it('counts every uncategorized transaction, transfers included (WHIT-330)', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee' })],
      transactions: [
        txn({ transaction_id: '1', category: null, counts_to_budget: true }),   // counts
        txn({ transaction_id: '2', category: 'coffee', counts_to_budget: true }), // categorized → no
        txn({ transaction_id: '3', category: null, counts_to_budget: false }),   // not-in-budget transfer → still counts
        txn({ transaction_id: '4', category: 'unknown', counts_to_budget: true }), // unmapped id → counts
      ],
    });
    expect(countUncategorized(s)).toBe(3);
  });

  it('counts a user-excluded (budget_excluded) uncategorized charge (WHIT-330)', () => {
    // WHIT-296 used to drop this; WHIT-330 counts it so the badge matches the row label.
    const s = makeState({
      categories: [cat({ id: 'coffee' })],
      transactions: [
        txn({ transaction_id: '1', category: null, counts_to_budget: true }),                        // counts
        txn({ transaction_id: '2', category: null, counts_to_budget: true, budget_excluded: true }), // still uncategorized → counts
      ],
    });
    expect(countUncategorized(s)).toBe(2);
  });
});

describe('transactionView', () => {
  it('renders an uncategorized row as tappable with the Uncategorized label', () => {
    const v = transactionView(state(), txn({ category: null }));
    expect(v.categoryLabel).toBe('Uncategorized');
    expect(v.tappable).toBe(true);
    expect(v.categoryWeight).toBe('700');
  });

  it('renders an income row with the Income label and is not tappable', () => {
    const v = transactionView(state(), txn({ category: 'income', amount: 2500 }));
    expect(v.categoryLabel).toBe('Income');
    expect(v.tappable).toBe(false);
    expect(v.amountColor).toBe(C.good); // positive amount → good/cyan
  });

  it('renders a categorized row with the category name and colour, not tappable', () => {
    const v = transactionView(state(), txn({ category: 'coffee' }));
    expect(v.categoryLabel).toBe('Cafes & Coffee');
    expect(v.tappable).toBe(false);
    expect(v.iconColor).toBe('#E8A87C');
  });

  it('formats the amount with sign and 2 decimals', () => {
    expect(transactionView(state(), txn({ amount: -12.5 })).amountLabel).toBe('-$12.50');
    expect(transactionView(state(), txn({ amount: 2500 })).amountLabel).toBe('+$2,500.00');
  });

  it('marks pending transactions', () => {
    expect(transactionView(state(), txn({ status: 'pending' })).isPending).toBe(true);
    expect(transactionView(state(), txn({ status: 'posted' })).isPending).toBe(false);
  });
});

describe('transactionGroups', () => {
  it('the uncategorized tab lists unmapped rows and drops categorized ones', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee' })],
      transactions: [
        txn({ transaction_id: '1', category: null, counts_to_budget: true, date: '2026-05-01' }),
        txn({ transaction_id: '2', category: 'coffee', counts_to_budget: true, date: '2026-05-01' }),
      ],
    });
    const groups = transactionGroups(s, 'uncategorized');
    const ids = groups.flatMap((g) => g.items.map((t) => t.transaction_id));
    expect(ids).toEqual(['1']);
  });

  it('the uncategorized tab KEEPS a user-excluded uncategorized charge (WHIT-330)', () => {
    // WHIT-296 dropped it here; WHIT-330 lists it so the tab matches the badge + row label.
    const s = makeState({
      categories: [cat({ id: 'coffee' })],
      transactions: [
        txn({ transaction_id: '1', category: null, counts_to_budget: true, date: '2026-05-01' }),
        txn({ transaction_id: '2', category: null, counts_to_budget: true, budget_excluded: true, date: '2026-05-01' }),
      ],
    });
    const groups = transactionGroups(s, 'uncategorized');
    const ids = groups.flatMap((g) => g.items.map((t) => t.transaction_id));
    expect(ids).toEqual(['1', '2']); // both are uncategorized; the excluded one is still listed
  });

  it('the all tab keeps every transaction, grouped by date', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee' })],
      transactions: [
        txn({ transaction_id: '1', date: '2026-05-01' }),
        txn({ transaction_id: '2', date: '2026-05-02' }),
      ],
    });
    const groups = transactionGroups(s, 'all');
    expect(groups).toHaveLength(2); // two distinct dates
  });
});

// WHIT-330 — the row's "Uncategorized" label, the badge count, and the tab list agree for
// EVERY uncategorized charge, transfers included. (A not-in-budget transfer keeps its quiet,
// non-tappable look from WHIT-328, but it is still labelled, counted, and listed.)
describe('WHIT-330 — badge/tab count every uncategorized charge, transfers included', () => {
  const oneUncat = (over: Parameters<typeof txn>[0]) =>
    makeState({ categories: [cat({ id: 'coffee' })], transactions: [txn({ transaction_id: 'x', category: null, ...over })] });

  it('an IN-BUDGET uncategorized charge is actionable: tappable row, counted, listed', () => {
    const s = oneUncat({ counts_to_budget: true });
    expect(transactionView(s, s.transactions[0]).tappable).toBe(true);
    expect(countUncategorized(s)).toBe(1);
    expect(transactionGroups(s, 'uncategorized').flatMap((g) => g.items.map((t) => t.transaction_id))).toEqual(['x']);
  });

  it('a NOT-IN-BUDGET uncategorized transfer is actionable everywhere: tappable, counted, listed', () => {
    const s = oneUncat({ counts_to_budget: false });
    const v = transactionView(s, s.transactions[0]);
    expect(v.categoryLabel).toBe('Uncategorized');
    expect(v.tappable).toBe(true);                  // purple, tap-to-file (WHIT-330 option A)
    expect(countUncategorized(s)).toBe(1);          // counted
    expect(transactionGroups(s, 'uncategorized').flatMap((g) => g.items.map((t) => t.transaction_id))).toEqual(['x']); // and listed
  });

  it('a list of only not-in-budget uncategorized transfers is fully counted (WHIT-330)', () => {
    const s = makeState({
      categories: [cat({ id: 'coffee' })],
      transactions: [
        txn({ transaction_id: 'a', category: null, counts_to_budget: false }),                        // bank transfer
        txn({ transaction_id: 'b', category: null, counts_to_budget: true, budget_excluded: true }),  // user-excluded
      ],
    });
    expect(countUncategorized(s)).toBe(2);
  });
});
