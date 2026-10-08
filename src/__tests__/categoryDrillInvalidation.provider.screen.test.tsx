// WHIT-342 GAP (BUG-DEMONSTRATING) — the ['categoryTransactions'] cache is the drill-in list's
// only source AND the source of its header total. staleTime is 45s (queryClient.ts), so if a
// categorise / budget-exclude write does NOT invalidate it, a drill opened within 45s of a
// re-tag serves the STALE list — and its header total then disagrees with the Insights /breakdown
// card (which IS invalidated). That reconciliation is the whole point of WHIT-342.
//
// The budget sibling invalidates ['budgetTransactions'] for exactly this reason (see
// budgetTxInvalidation.provider.screen.test.tsx + context.tsx invalidateAfterCategorise). These
// assert the SAME contract for ['categoryTransactions'].
//
// PREREQUISITE / STATUS: as committed, these FAIL — the three write sites (invalidateAfterCategorise
// ~L741, the bulk-categorise block ~L913, the budget_excluded block ~L950) invalidate
// budgets/breakdown/transactions/budgetTransactions but NOT categoryTransactions. The fix is a
// one-line `queryClient.invalidateQueries({ queryKey: ['categoryTransactions'] })` at each site;
// with it applied these pass and are the fail-on-revert guard.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { GROCERIES } from './support/categories';
import { invalidatedKeys } from './support/queryClient';
import { colesTxn as txn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const CAT = GROCERIES;
beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount(transactions: Transaction[] = [txn()]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// [A-inval-cat-one] re-tagging one charge moves it between categories, so BOTH the old and new
// category's drill lists (+ their header totals) are now wrong until refetched. The Insights card
// refreshes (breakdown IS invalidated); the drill must too, or they disagree for up to 45s.
it('applyCategory(one) invalidates categoryTransactions (drill stays reconciled with the card)', async () => {
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategory('one'); });

  expect(invalidatedKeys(spy)).toContain('categoryTransactions');
  spy.mockRestore();
});

// [A-inval-cat-exclude] excluding a charge drops it from the drill's contributing total, exactly
// as it drops from the /breakdown card — the drill list must refresh in lockstep.
it('applyTransactionEdit(budget_excluded) invalidates categoryTransactions', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(invalidatedKeys(spy)).toContain('categoryTransactions');
  spy.mockRestore();
});

// [A-inval-cat-guard] a note edit changes neither total nor membership, so it must NOT invalidate
// the drill list (same guard as budgetTransactions). This one PASSES today (nothing invalidates it)
// but locks the guard once the fix lands: the fix must sit INSIDE the budget_excluded branch.
it('applyTransactionEdit(notes) does NOT invalidate categoryTransactions', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch' }); });

  expect(invalidatedKeys(spy)).not.toContain('categoryTransactions');
  spy.mockRestore();
});
