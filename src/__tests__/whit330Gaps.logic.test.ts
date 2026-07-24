// WHIT-330 — adversarial GAP: the cross-surface CONSISTENCY the card leaves implicit.
// The implementer covers countUncategorized/transactionGroups counting transfers. These lock the
// OTHER half of the invariant: the Uncategorized BADGE/TAB now include a not-in-budget transfer,
// but the Insights "Uncategorized spend" bucket (categoryTransactions) STILL excludes it — budget
// MATH is untouched. So the tab count and the Insights uncategorized count are deliberately
// DIFFERENT numbers. This is the regression guard that WHIT-330 didn't leak transfers into money.
import { describe, it, expect } from '@jest/globals';
import { countUncategorized, categoryTransactions, transactionGroups, UNCATEGORIZED_KEY } from '../context';
import { makeState, cat, txn } from './factory';

const OPEN = { start: '2026-01-01', end: '2026-12-31' };

// One real in-budget uncategorized charge ($30) + one not-in-budget transfer ($500), both unmapped.
function stateWithTransfer() {
  return makeState({
    categories: [cat({ id: 'coffee' })],
    transactions: [
      txn({ transaction_id: 'u1', category: null, counts_to_budget: true, amount: -30, status: 'posted', date: '2026-06-10' }),
      txn({ transaction_id: 'xfer', category: null, counts_to_budget: false, amount: -500, status: 'posted', date: '2026-06-10' }),
    ],
  });
}

describe('WHIT-330 — badge/tab count the transfer, Insights spend bucket still excludes it', () => {
  // [A-div1] The badge + tab count BOTH the in-budget charge AND the transfer (2).
  it('countUncategorized and the uncategorized tab both include the not-in-budget transfer', () => {
    const s = stateWithTransfer();
    expect(countUncategorized(s)).toBe(2);
    const tabIds = transactionGroups(s, 'uncategorized').flatMap((g) => g.items.map((t) => t.transaction_id)).sort();
    expect(tabIds).toEqual(['u1', 'xfer']);
  });

  // [A-div2] REGRESSION GUARD: the Insights "Uncategorized" drill still lists + totals ONLY the
  // budget-contributing charge — the $500 transfer is absent from the list AND from the total.
  // Fail-on-revert: dropping the `contributesToBudget(t)` gate in categoryTransactions (line ~2221)
  // pulls the transfer into the list (['u1','xfer']) and lifts the total to 530 — this fails.
  it('the Insights Uncategorized spend bucket excludes the transfer from both list and total', () => {
    const s = stateWithTransfer();
    const detail = categoryTransactions(s, UNCATEGORIZED_KEY, OPEN)!;
    expect(detail.groups.flatMap((g) => g.items.map((t) => t.transaction_id))).toEqual(['u1']);
    expect(detail.count).toBe(1);
    expect(detail.total).toBe(30); // the $500 transfer never reaches budget math
  });

  // [A-div3] The two surfaces are DELIBERATELY inconsistent numbers: tab=2, Insights spend=1.
  // Documents the accepted divergence so a future "make them match" change trips a red test and
  // has to decide WHICH surface to move (see critique — the honest fix is a label, not the math).
  it('the tab count (2) and the Insights uncategorized count (1) are intentionally different', () => {
    const s = stateWithTransfer();
    const insights = categoryTransactions(s, UNCATEGORIZED_KEY, OPEN)!;
    expect(countUncategorized(s)).not.toBe(insights.count);
  });
});
