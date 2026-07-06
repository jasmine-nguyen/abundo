// WHIT-190a/192 — the categorise write's cache write + invalidation (the WHIT-193 closure).
// Drives the REAL applyCategory through AppProvider (../api + ../auth mocked) and asserts it
// updates the singleton ['transactions'] query cache, rolls it back on failure, and
// invalidates ['budgets']/['breakdown']/['transactions'] so the migrated
// Budgets/Insights/Transactions screens refresh. (Pre-192 it also wrote an old store; gone.)
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
const txn = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const cachedCategory = (id: string) => (queryClient.getQueryData<Transaction[]>(['transactions']) ?? []).find((t) => t.transaction_id === id)?.category;

beforeEach(() => {
  queryClient.clear();
  mockApi.createEnrichment.mockResolvedValue({ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
});

// The singleton queryClient's gcTime schedules a timer for inactive cached data;
// clear after each test so no timer leaks past the suite (worker-exit warning).
afterEach(() => {
  queryClient.clear();
});

// WHIT-192: seed the ['transactions'] + ['categories'] caches applyCategory reads (the
// provider no longer eager-loads), then mount.
function mount(transactions: Transaction[] = [txn('t1'), txn('t2')]) {
  queryClient.setQueryData(['transactions'], transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  // ['budgets', cycleLen] caches the RAW Record<categoryId, BudgetRollup> (select maps it).
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('applyCategory(one) writes the tx cache AND invalidates budgets/breakdown/transactions', async () => {
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('one'); });

  expect(cachedCategory('t1')).toBe('groceries'); // query cache write
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'transactions'])); // WHIT-193 closure
  invalidateSpy.mockRestore();
});

it('applyCategory(one) rolls the cache back on failure', async () => {
  mockApi.setTransactionCategory.mockRejectedValue(new Error('boom'));
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(cachedCategory('t1')).toBeNull(); // query cache reverted
});

it('applyCategory(all) writes every same-merchant charge into the cache + invalidates', async () => {
  const result = mount();

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
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries'); // saved → stays
  expect(cachedCategory('t2')).toBeNull(); // not saved → reverted (partial rollback)
});
