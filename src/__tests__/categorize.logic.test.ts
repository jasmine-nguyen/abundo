// Categorization selectors: isUncategorized / countUncategorized (drive the
// "uncategorized" tab + badge) and transactionView (drives every row's label,
// colour, pending flag, and tappability). Single sources of truth, so a
// regression here would silently mislabel money.
import { describe, it, expect } from '@jest/globals';
import { isUncategorized, countUncategorized, transactionView, transactionGroups, transactionMatchesSearch, categoryTransactions, UNCATEGORIZED_KEY } from '../context';
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

// ===== WHIT-330/WHIT-328 (folded from whit328Gaps.logic.test.ts) — the Uncategorized badge/tab
// count EVERY unmapped charge, transfers included, with WHIT-328's row styling. Locks: the purple,
// tappable to-do styling of every uncategorized row (in/out of budget), a not-in-budget row with a
// NON-NULL unknown id counted + listed, an IN-BUDGET unknown-id charge staying actionable, and
// search surfacing such a transfer under "uncategorized". transactionMatchesSearch import merged
// above. state() is reused from the survivor above (byte-identical; the gaps duplicate is dropped).

// [A-style] WHIT-330 (option A): EVERY uncategorized row is the actionable purple "Uncategorized"
// to-do — purple icon/label, weight 700, purple chip, tappable — regardless of budget status. A
// not-in-budget transfer looks and behaves exactly like an in-budget unfiled charge. Fail-on-revert:
// re-gate the row on inBudget (the old WHIT-328 quiet treatment) → the not-in-budget row flips to
// grey/non-tappable and this fails.
describe('WHIT-330 [A-style] — every uncategorized row is the purple, tappable to-do', () => {
  it('a not-in-budget uncategorized row is purple, weight 700, tappable (same as in-budget)', () => {
    const v = transactionView(state(), txn({ category: null, counts_to_budget: false }));
    expect(v.icon).toBe('q');
    expect(v.iconColor).toBe(C.purple);
    expect(v.categoryColor).toBe(C.purple);
    expect(v.categoryWeight).toBe('700');
    expect(v.chipBg).toBe('rgba(160,130,240,.16)');
    expect(v.tappable).toBe(true);
  });

  it('an in-budget uncategorized row is the same purple to-do', () => {
    const v = transactionView(state(), txn({ category: null, counts_to_budget: true }));
    expect(v.iconColor).toBe(C.purple);
    expect(v.categoryWeight).toBe('700');
    expect(v.tappable).toBe(true);
  });

  it('a row with counts_to_budget undefined is still the purple, tappable to-do', () => {
    const v = transactionView(state(), txn({ category: null, counts_to_budget: undefined }));
    expect(v.tappable).toBe(true);
  });
});

// [A-unmapped] A charge is uncategorized when it carries a NON-NULL id the taxonomy doesn't know
// (a raw BankSync enum). When not-in-budget it behaves like the category:null case: labelled
// Uncategorized, neutral, AND — under WHIT-330 — counted + listed. Proves the counting keys off
// isUncategorized (the taxonomy test), not a shallow `category == null`.
describe('WHIT-330 [A-unmapped] — a not-in-budget UNKNOWN-id charge is counted + listed', () => {
  const s = () => makeState({
    categories: [cat({ id: 'coffee' })],
    transactions: [txn({ transaction_id: 'x', category: 'FOOD_AND_DRINK', counts_to_budget: false })],
  });

  it('renders labelled Uncategorized, purple, tappable', () => {
    const st = s();
    const v = transactionView(st, st.transactions[0]);
    expect(v.categoryLabel).toBe('Uncategorized');
    expect(v.tappable).toBe(true);
    expect(v.categoryColor).toBe(C.purple);
  });

  it('counts toward the badge and is listed in the uncategorized tab (WHIT-330)', () => {
    const st = s();
    expect(countUncategorized(st)).toBe(1);
    expect(transactionGroups(st, 'uncategorized').flatMap((g) => g.items.map((t) => t.transaction_id))).toEqual(['x']);
  });
});

// [A-unmapped-in] An IN-BUDGET unknown-id charge stays an actionable uncategorized to-do — it
// must never fall through to the `s.category(t.category)!` branch. Proves the early-return order.
describe('WHIT-328 [A-unmapped-in] — an in-budget unknown-id charge stays actionable', () => {
  it('is tappable, labelled Uncategorized, counted, and listed', () => {
    const st = makeState({
      categories: [cat({ id: 'coffee' })],
      transactions: [txn({ transaction_id: 'x', category: 'RAW_ENUM', counts_to_budget: true })],
    });
    const v = transactionView(st, st.transactions[0]);
    expect(v.categoryLabel).toBe('Uncategorized');
    expect(v.tappable).toBe(true);
    expect(countUncategorized(st)).toBe(1);
    expect(transactionGroups(st, 'uncategorized').flatMap((g) => g.items.map((t) => t.transaction_id))).toEqual(['x']);
  });
});

// [A-search] Search reads the label the user sees, so a not-in-budget uncategorized transfer
// matches the query "uncategorized".
describe('WHIT-328 [A-search] — search surfaces a not-in-budget transfer under "uncategorized"', () => {
  it('matches "uncategorized" for a not-in-budget uncategorized charge', () => {
    expect(transactionMatchesSearch(state(), txn({ merchant_name: 'Internal xfer', category: null, counts_to_budget: false }), 'uncategorized')).toBe(true);
  });
});

// ===== WHIT-330 (folded from whit330Gaps.logic.test.ts) — adversarial GAP: the cross-surface
// CONSISTENCY the card leaves implicit. The badge/tab now include a not-in-budget transfer, but the
// Insights "Uncategorized spend" bucket (categoryTransactions) STILL excludes it — budget MATH is
// untouched — so the tab count and the Insights count are deliberately DIFFERENT numbers.
// categoryTransactions + UNCATEGORIZED_KEY imports merged above. feedWithTransfer / uncatDrillRows
// are gaps-only helpers kept at module level.

// The full transaction feed the badge/tab read: one in-budget uncategorized charge ($30) + one
// not-in-budget transfer ($500), both unmapped.
function feedWithTransfer() {
  return makeState({
    categories: [cat({ id: 'coffee' })],
    transactions: [
      txn({ transaction_id: 'u1', category: null, counts_to_budget: true, amount: -30, status: 'posted', date: '2026-06-10' }),
      txn({ transaction_id: 'xfer', category: null, counts_to_budget: false, amount: -500, status: 'posted', date: '2026-06-10' }),
    ],
  });
}

// What the /categories/__uncategorized__/transactions endpoint returns: the transfer is excluded
// server-side (contributes_to_budget gate), so the drill only ever sees the in-budget charge.
function uncatDrillRows() {
  return makeState({
    categories: [cat({ id: 'coffee' })],
    transactions: [
      txn({ transaction_id: 'u1', category: null, counts_to_budget: true, amount: -30, status: 'posted', date: '2026-06-10' }),
    ],
  });
}

describe('WHIT-330 — badge/tab count the transfer, Insights spend bucket still excludes it', () => {
  // [A-div1] The badge + tab count BOTH the in-budget charge AND the transfer (2).
  it('countUncategorized and the uncategorized tab both include the not-in-budget transfer', () => {
    const s = feedWithTransfer();
    expect(countUncategorized(s)).toBe(2);
    const tabIds = transactionGroups(s, 'uncategorized').flatMap((g) => g.items.map((t) => t.transaction_id)).sort();
    expect(tabIds).toEqual(['u1', 'xfer']);
  });

  // [A-div2] REGRESSION GUARD: the Insights "Uncategorized" drill lists + totals ONLY the
  // budget-contributing charge — the $500 transfer is excluded server-side (the uncat branch of
  // get_category_transactions), so it never reaches this list or total. The server fail-on-revert
  // lives in tests/lambda_api/test_category_transactions.py.
  it('the Insights Uncategorized spend bucket excludes the transfer from both list and total', () => {
    const detail = categoryTransactions(uncatDrillRows(), UNCATEGORIZED_KEY)!;
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id))).toEqual(['u1']);
    expect(detail.count).toBe(1);
    expect(detail.total).toBe(30); // the $500 transfer never reaches budget math
  });

  // [A-div3] The two surfaces are DELIBERATELY inconsistent numbers: tab=2 (feed), Insights=1 (drill).
  it('the tab count (2) and the Insights uncategorized count (1) are intentionally different', () => {
    const insights = categoryTransactions(uncatDrillRows(), UNCATEGORIZED_KEY)!;
    expect(countUncategorized(feedWithTransfer())).not.toBe(insights.count);
  });
});
