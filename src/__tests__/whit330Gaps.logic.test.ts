// WHIT-330 — adversarial GAP: the cross-surface CONSISTENCY the card leaves implicit.
// The implementer covers countUncategorized/transactionGroups counting transfers. These lock the
// OTHER half of the invariant: the Uncategorized BADGE/TAB now include a not-in-budget transfer,
// but the Insights "Uncategorized spend" bucket (categoryTransactions) STILL excludes it — budget
// MATH is untouched. So the tab count and the Insights uncategorized count are deliberately
// DIFFERENT numbers. Post-WHIT-342 the two surfaces read DIFFERENT sources: the tab reads the full
// transaction feed, the Insights drill reads the /categories/{id}/transactions endpoint, which
// excludes the transfer server-side.
import { describe, it, expect } from '@jest/globals';
import { countUncategorized, categoryTransactions, transactionGroups, UNCATEGORIZED_KEY } from '../context';
import { makeState, cat, txn } from './factory';

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
