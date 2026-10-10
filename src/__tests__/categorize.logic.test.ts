// Categorization selectors: isUncategorized / countUncategorized (drive the
// "uncategorized" tab + badge) and transactionView (drives every row's label,
// colour, pending flag, and tappability). Single sources of truth, so a
// regression here would silently mislabel money.
import { describe, it, expect } from '@jest/globals';
import { isUncategorized, countUncategorized, transactionView, transactionGroups, transactionMatchesSearch } from '../context';
import { C, MINUS } from '../theme';
import type { Transaction } from '../types';
import { makeState, cat, txn } from './factory';
import { GROCERIES, SALARY, SAVINGS } from './support/categories';

const state = () => makeState({ categories: [cat()] });

describe('isUncategorized', () => {
  it.each([
    ['null', null, true],
    ['an id not in the taxonomy', 'raw_bank_code', true],
    ['a known category', 'coffee', false],
    ["'income' (categorized)", 'income', false],
  ])('category %s → %s', (_case, category, expected) => {
    expect(isUncategorized(state(), txn({ category }))).toBe(expected);
  });
});

describe('countUncategorized', () => {
  it('counts every uncategorized transaction, transfers included (WHIT-330)', () => {
    const s = makeState({
      categories: [cat()],
      transactions: [
        txn({ transaction_id: '1', category: null, counts_to_budget: true }),   // counts
        txn({ transaction_id: '2', category: 'coffee', counts_to_budget: true }), // categorized → no
        txn({ transaction_id: '3', category: null, counts_to_budget: false }),   // not-in-budget transfer → still counts
        txn({ transaction_id: '4', category: 'unknown', counts_to_budget: true }), // unmapped id → counts
        txn({ transaction_id: '5', category: null, counts_to_budget: true, budget_excluded: true }), // user-excluded → still counts
      ],
    });
    expect(countUncategorized(s)).toBe(4);
  });
});

describe('transactionView', () => {
  it.each([
    ['null', { category: null }],
    ['not in budget', { category: null, counts_to_budget: false }],
    ['unknown id', { category: 'RAW_ENUM', counts_to_budget: true }],
  ])('renders an uncategorized row (%s) as tappable with the Uncategorized label', (_case, over) => {
    const v = transactionView(state(), txn(over));
    expect(v.categoryLabel).toBe('Uncategorised');
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
  });

  // WHIT-158: a USER income category renders as itself, not the grey BankSync 'income' pseudo-category.
  it('renders its own name + icon + colour (not the grey "Income" pseudo-label)', () => {
    const s = makeState({
      categories: [cat({ id: 'salary', name: 'Salary', icon: 'briefcase', color: '#35d9a0', bucket: 'Income' })],
    });
    const v = transactionView(s, txn({ category: 'salary', amount: 5000 }));
    expect(v.categoryLabel).toBe('Salary');   // NOT 'Income'
    expect(v.icon).toBe('briefcase');          // NOT the pseudo 'home'
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

  it('the uncategorized tab KEEPS a user-excluded uncategorized charge (WHIT-330)', () => {
    // WHIT-296 dropped it here; WHIT-330 lists it so the tab matches the badge + row label.
    const s = makeState({
      categories: [cat()],
      transactions: [
        txn({ transaction_id: '1', category: null, counts_to_budget: true, date: '2026-05-01' }),
        txn({ transaction_id: '2', category: null, counts_to_budget: true, budget_excluded: true, date: '2026-05-01' }),
        txn({ transaction_id: '3', category: 'coffee', counts_to_budget: true, date: '2026-05-01' }), // categorized → dropped
      ],
    });
    const groups = transactionGroups(s, 'uncategorized');
    const ids = groups.flatMap((g) => g.items.map((t) => t.transaction_id));
    expect(ids).toEqual(['1', '2']); // both are uncategorized; the excluded one is still listed
  });

  it('the all tab keeps every transaction, grouped by date', () => {
    const s = makeState({
      categories: [cat()],
      transactions: [
        txn({ transaction_id: '1', date: '2026-05-01' }),
        txn({ transaction_id: '2', date: '2026-05-02' }),
      ],
    });
    const groups = transactionGroups(s, 'all');
    expect(groups).toHaveLength(2); // two distinct dates
  });

  // WHIT-847: each date heading's total counts what Insights "Spent" counts — pending and
  // posted charges in Living/Lifestyle + uncategorized, refunds netting; income, savings,
  // budget-excluded charges and transfers (counts_to_budget: false) are left out.
  const day = (over: Partial<Transaction>) => txn({ date: '2026-05-01', ...over });
  it.each<[string, Partial<Transaction>[], string | null]>([
    ['two charges, with cents', [{ amount: -20 }, { amount: -12.5 }], `${MINUS}$32.50`],
    ['a pending charge counts', [{ amount: -10, status: 'pending' }, { amount: -5 }], `${MINUS}$15`],
    ['a budget-excluded charge is left out', [{ amount: -100, budget_excluded: true }, { amount: -10 }], `${MINUS}$10`],
    ['a transfer (counts_to_budget false) is left out', [{ amount: -100, counts_to_budget: false }, { amount: -10 }], `${MINUS}$10`],
    ["the 'income' row is left out", [{ amount: 1000, category: 'income' }, { amount: -10 }], `${MINUS}$10`],
    ['an Income-bucket category row is left out', [{ amount: 500, category: SALARY.id }, { amount: -10 }], `${MINUS}$10`],
    ['a Savings-bucket category row is left out', [{ amount: -50, category: SAVINGS.id }, { amount: -10 }], `${MINUS}$10`],
    ['a refund nets against a charge', [{ amount: 5 }, { amount: -20 }], `${MINUS}$15`],
    ['a refund-only day reads as money back', [{ amount: 7.25 }], '+$7.25'],
    ['an uncategorized charge counts', [{ amount: -9, category: null }], `${MINUS}$9`],
    ['an income-only day has no total', [{ amount: 1000, category: 'income' }], null],
    ['a day that nets to zero has no total', [{ amount: 10 }, { amount: -10 }], null],
    // [A2] float dust below a cent is zero, not "−$0"
    ['a day that nets to under a cent has no total', [{ amount: -0.1 }, { amount: -0.2 }, { amount: 0.3 }], null],
  ])('dayTotal: %s', (_name, rows, expected) => {
    const s = makeState({
      categories: [cat(), GROCERIES, SALARY, SAVINGS],
      transactions: rows.map((over, i) => day({ transaction_id: String(i), ...over })),
    });
    const groups = transactionGroups(s, 'all');
    expect(groups).toHaveLength(1);
    expect(groups[0].dayTotal ?? null).toBe(expected);
  });

  // [A3] each heading totals only its own day, not the running list
  it('dayTotal is per day: each date heading sums only its own rows', () => {
    const s = makeState({
      categories: [cat(), GROCERIES],
      transactions: [
        day({ transaction_id: '1', amount: -10, date: '2026-05-02' }),
        day({ transaction_id: '2', amount: -3, date: '2026-05-01' }),
        day({ transaction_id: '3', amount: 1000, category: 'income', date: '2026-04-30' }),
      ],
    });
    expect(transactionGroups(s, 'all').map((g) => g.dayTotal)).toEqual([`${MINUS}$10`, `${MINUS}$3`, null]);
  });

  it('dayTotal on the uncategorized tab totals only the uncategorized rows', () => {
    const s = makeState({
      categories: [cat(), GROCERIES],
      transactions: [
        day({ transaction_id: '1', amount: -10, category: GROCERIES.id }),
        day({ transaction_id: '2', amount: -9, category: null }),
      ],
    });
    expect(transactionGroups(s, 'uncategorized')[0].dayTotal).toBe(`${MINUS}$9`);
  });
});

// [A-search] Search reads the label the user sees, so a not-in-budget uncategorized transfer
// matches the query "uncategorized".
describe('WHIT-328 [A-search] — search surfaces a not-in-budget transfer under "uncategorized"', () => {
  it('matches "uncategorized" for a not-in-budget uncategorized charge', () => {
    expect(transactionMatchesSearch(state(), txn({ merchant_name: 'Internal xfer', category: null, counts_to_budget: false }), 'uncategorized')).toBe(true);
  });
});

