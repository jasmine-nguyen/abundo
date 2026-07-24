// WHIT-328 — adversarial GAP logic tests for the "quiet, not-in-budget uncategorized" row.
// The implementer already covers: in-budget uncat = tappable/counted/listed; not-in-budget
// uncat (category:null) = labelled/not-tappable/not-counted/not-listed; empty-state badge 0.
// These add the UNCOVERED edges the card called out:
//   [A-style]     the exact NEUTRAL styling of the quiet row vs the actionable purple one
//   [A-unmapped]  a not-in-budget row whose category is a NON-NULL unknown id (raw bank enum)
//   [A-unmapped-in] an IN-BUDGET unknown-id charge is still actionable (guards the final branch)
//   [A-search]    search still surfaces such a transfer under "uncategorized" (All-tab reachable)
import { describe, it, expect } from '@jest/globals';
import { transactionView, countUncategorized, transactionGroups, transactionMatchesSearch } from '../context';
import { C } from '../theme';
import { makeState, cat, txn } from './factory';

const state = () => makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee', color: '#E8A87C' })] });

// [A-style] The quiet not-in-budget uncategorized row must render with the SAME neutral
// treatment as any other non-actionable row — grey icon/label, the dim chip wash, weight 500 —
// NOT the purple actionable "Uncategorized" treatment. This is the whole point of the fix: the
// row must not LOOK like a to-do. Fail-on-revert: drop the `actionable` gate (make it purple
// again) → every one of these flips and the test fails.
describe('WHIT-328 [A-style] — the quiet row is visually neutral, the actionable one is purple', () => {
  it('a not-in-budget uncategorized row is neutral grey (textMid), dim chip, weight 500, still the "q" icon', () => {
    const v = transactionView(state(), txn({ category: null, counts_to_budget: false }));
    expect(v.icon).toBe('q');
    expect(v.iconColor).toBe(C.textMid);
    expect(v.categoryColor).toBe(C.textMid);
    expect(v.categoryWeight).toBe('500');
    expect(v.chipBg).toBe('rgba(255,255,255,.06)');
    expect(v.tappable).toBe(false);
    expect(v.excluded).toBe(true);
  });

  it('an in-budget uncategorized row is the actionable purple to-do (weight 700, purple chip)', () => {
    const v = transactionView(state(), txn({ category: null, counts_to_budget: true }));
    expect(v.iconColor).toBe(C.purple);
    expect(v.categoryColor).toBe(C.purple);
    expect(v.categoryWeight).toBe('700');
    expect(v.chipBg).toBe('rgba(160,130,240,.16)');
    expect(v.tappable).toBe(true);
    expect(v.excluded).toBe(false);
  });

  // When the server omits counts_to_budget, tappable must be a strict boolean false, never
  // undefined — the row is quiet, and the field honours its `boolean` type. Fail-on-revert:
  // drop the `!!` in contributesToBudget and tappable becomes undefined, so toBe(false) fails.
  it('a row with counts_to_budget undefined is quiet with a strict boolean tappable=false', () => {
    const v = transactionView(state(), txn({ category: null, counts_to_budget: undefined }));
    expect(v.tappable).toBe(false);
    expect(v.excluded).toBe(true);
  });
});

// [A-unmapped] The existing not-in-budget tests all use category:null. But a transaction is
// ALSO uncategorized when it carries a NON-NULL id the taxonomy doesn't know (a raw BankSync
// enum not yet mapped). Such a charge, when not-in-budget, must behave EXACTLY like the null
// case: labelled Uncategorized, quiet, not counted, not listed. This proves the fix keys off
// isUncategorized (the taxonomy test), not a shallow `category == null`.
describe('WHIT-328 [A-unmapped] — a not-in-budget UNKNOWN-id charge is quiet everywhere', () => {
  const s = () => makeState({
    categories: [cat({ id: 'coffee' })],
    transactions: [txn({ transaction_id: 'x', category: 'FOOD_AND_DRINK', counts_to_budget: false })],
  });

  it('renders labelled Uncategorized but neutral + not tappable', () => {
    const st = s();
    const v = transactionView(st, st.transactions[0]);
    expect(v.categoryLabel).toBe('Uncategorized');
    expect(v.tappable).toBe(false);
    expect(v.categoryColor).toBe(C.textMid);
    expect(v.excluded).toBe(true);
  });

  it('does not count toward the badge and is not in the uncategorized tab', () => {
    const st = s();
    expect(countUncategorized(st)).toBe(0);
    expect(transactionGroups(st, 'uncategorized').flatMap((g) => g.items)).toEqual([]);
  });
});

// [A-unmapped-in] Regression guard for the refactor's final branch. An IN-BUDGET unknown-id
// charge must STAY an actionable uncategorized to-do — it must never fall through to the
// `s.category(t.category)!` branch (which would non-null-assert an undefined lookup and crash /
// mislabel). Proves the early-return order (uncategorized BEFORE the category lookup) holds.
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

// [A-search] Cross-surface check: search reads the LABEL the user sees, so a not-in-budget
// uncategorized transfer STILL matches the query "uncategorized" — meaning it is reachable on
// the (unfiltered) All tab via search, even though it is intentionally absent from the
// Uncategorized tab/badge. Documents that the fix narrows the TAB, not the label/search.
describe('WHIT-328 [A-search] — search still surfaces a not-in-budget transfer under "uncategorized"', () => {
  it('matches "uncategorized" for a not-in-budget uncategorized charge', () => {
    expect(transactionMatchesSearch(state(), txn({ merchant_name: 'Internal xfer', category: null, counts_to_budget: false }), 'uncategorized')).toBe(true);
  });
});
