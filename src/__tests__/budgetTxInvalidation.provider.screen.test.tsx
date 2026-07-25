// QA GAP — the ['budgetTransactions'] cache invalidations that keep the budget-detail list
// reconciled with its header after a write. Drives the REAL actions through AppProvider
// (../api + ../auth mocked). The implementer's transactionEdit.provider / transactionsCategorize.
// provider tests assert the ['transactions']/['budgets']/['breakdown'] keys but NOT the new
// ['budgetTransactions'] key, and don't prove the budget_excluded GUARD (a note edit must NOT
// invalidate the budget lists). These lock both.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

// The [0] element of every invalidateQueries call — the top-level query key.
function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}

beforeEach(() => {
  queryClient.clear();
  mockApi.createEnrichment.mockResolvedValue({ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
});
afterEach(() => { queryClient.clear(); }); // clear the singleton's gcTime timers

function mount(transactions: Transaction[] = [txn()]) {
  queryClient.setQueryData(['transactions'], transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// [A-inval-exclude] excluding a charge must refresh the budget-detail LIST too, so the header
// (which now drops it) and the rows below it stay reconciled. FAIL-ON-REVERT: removing the
// `if ('budget_excluded' in patch)` invalidation block drops 'budgetTransactions' here.
it('applyTransactionEdit(budget_excluded) invalidates budgets/breakdown/budgetTransactions', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true });
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['transactions', 'budgets', 'breakdown', 'budgetTransactions']));
  spy.mockRestore();
});

// [A-inval-guard] a note edit changes NEITHER the total nor the cycle list, so it must NOT
// invalidate the budget lists (that would refetch every open budget for a cosmetic note).
// FAIL-ON-REVERT: hoisting the budget invalidations out of the `budget_excluded` guard makes a
// note edit invalidate 'budgetTransactions' here.
it('applyTransactionEdit(notes) invalidates ONLY transactions — not the budget lists', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', notes: 'lunch' });
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch' }); });

  const keys = invalidatedKeys(spy);
  expect(keys).toContain('transactions');
  expect(keys).not.toContain('budgetTransactions');
  expect(keys).not.toContain('budgets');
  spy.mockRestore();
});

// [A-inval-categorise-one] re-tagging a charge moves it between budgets' cycle lists, so the
// budget-detail lists must refresh. FAIL-ON-REVERT: dropping the ['budgetTransactions'] line in
// invalidateAfterCategorise makes this key absent.
it('applyCategory(one) invalidates budgetTransactions alongside budgets/breakdown/transactions', async () => {
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategory('one'); });

  expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'transactions', 'budgetTransactions']));
  spy.mockRestore();
});
