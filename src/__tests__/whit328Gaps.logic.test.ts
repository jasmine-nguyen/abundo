// WHIT-330 — the Uncategorized badge/tab count EVERY unmapped charge, transfers included.
// WHIT-328's quiet look for a not-in-budget uncategorized row is RETAINED (grey, non-tappable),
// but it is now counted + listed like any other uncategorized charge. These lock:
//   [A-style]      the neutral styling of a not-in-budget uncat row vs the actionable purple one
//   [A-unmapped]   a not-in-budget row whose category is a NON-NULL unknown id (raw bank enum)
//                  is counted + listed, same as the category:null case
//   [A-unmapped-in] an IN-BUDGET unknown-id charge is still actionable (guards the final branch)
//   [A-search]     search surfaces such a transfer under "uncategorized"
import { describe, it, expect } from '@jest/globals';
import { transactionView, countUncategorized, transactionGroups, transactionMatchesSearch } from '../context';
import { C } from '../theme';
import { makeState, cat, txn } from './factory';

const state = () => makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })] });

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
