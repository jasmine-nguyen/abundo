// WHIT-190a — the categorise write's double-write + cache invalidation (the WHIT-193
// closure). Drives the REAL applyCategory through AppProvider (../api + ../auth mocked)
// and asserts it updates BOTH the old store AND the singleton ['transactions'] query
// cache, rolls BOTH back on failure, and invalidates ['budgets']/['breakdown']/
// ['transactions'] so the migrated Budgets/Insights/Transactions screens refresh.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (id: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null as string | null, status: 'posted' as const, type: 'PAYMENT', counts_to_budget: true,
});
const cachedCategory = (id: string) => (queryClient.getQueryData(['transactions']) as { transaction_id: string; category: string | null }[]).find((t) => t.transaction_id === id)?.category;

beforeEach(() => {
  queryClient.clear();
  mockApi.fetchTransactions.mockResolvedValue([txn('t1'), txn('t2')]);
  mockApi.fetchCategories.mockResolvedValue([{ ...CAT }]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchBreakdown.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchLoanFacts.mockResolvedValue({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.listEnrichments.mockResolvedValue([]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
});

// The singleton queryClient's gcTime schedules a timer for inactive cached data;
// clear after each test so no timer leaks past the suite (worker-exit warning).
afterEach(() => {
  queryClient.clear();
});

async function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.transactions.length).toBeGreaterThan(0));
  return result;
}

it('applyCategory(one) double-writes the tx cache AND invalidates budgets/breakdown/transactions', async () => {
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  queryClient.setQueryData(['transactions'], [txn('t1'), txn('t2')]); // the migrated list's cache
  const result = await mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('one'); });

  expect(result.current.transactions[0].category).toBe('groceries'); // old store
  expect(cachedCategory('t1')).toBe('groceries'); // query cache (double-write)
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'transactions'])); // WHIT-193 closure
  invalidateSpy.mockRestore();
});

it('applyCategory(one) rolls BOTH stores back on failure', async () => {
  mockApi.setTransactionCategory.mockRejectedValue(new Error('boom'));
  queryClient.setQueryData(['transactions'], [txn('t1'), txn('t2')]);
  const result = await mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(result.current.transactions[0].category).toBeNull(); // old store reverted
  expect(cachedCategory('t1')).toBeNull(); // query cache reverted (symmetric)
});

it('applyCategory(all) double-writes every same-merchant charge into the cache + invalidates', async () => {
  queryClient.setQueryData(['transactions'], [txn('t1'), txn('t2')]);
  const result = await mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t2')).toBe('groceries'); // the whole same-merchant sweep hit the cache
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'transactions']));
  invalidateSpy.mockRestore();
});

it('applyCategory(all) rolls back ONLY the failed ids in the cache (partial)', async () => {
  // t2's save comes back not-updated → only t2 reverts; t1 stays categorised.
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] });
  queryClient.setQueryData(['transactions'], [txn('t1'), txn('t2')]);
  const result = await mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries'); // saved → stays
  expect(cachedCategory('t2')).toBeNull(); // not saved → reverted (partial rollback)
});
