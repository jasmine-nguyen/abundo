// WHIT-576: a Transactions-tab search result deep in history lives ONLY in the
// ['transactionsSearch', tab, query] cache — not in the loaded feed pages or the recent window.
// These lock what makes such a row usable once found:
//
//   1. RESOLVE — the write path (readTransactionsCache) reads the search cache by PREFIX, or
//      tapping a found row files nothing (applyCategory bails "not found" → no API call).
//   2. PATCH — every instant edit lands in the search cache, again by prefix (the real key carries
//      the tab + query, so an exact ['transactionsSearch'] write would silently match nothing).
//   3. INVALIDATE — server-side re-files (apply-rules) and category delete/rename refresh searches.
//
// Fail-on-revert: drop readSearchRows from readTransactionsCache → [1] fails; drop the
// setQueriesData arm from patchTransactionsCache → [2]/[3]/[4]/[5] fail; drop an invalidate → [6]/[7] fail.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import type { TransactionSearchResult } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const SEARCH_KEY = ['transactionsSearch', 'all', 'steven'];
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 'deep1', date: '2020-01-01', authorized_date: '2020-01-01',
  description: 'STEVEN NGUYEN', merchant_name: 'Steven Nguyen', amount: -50, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

function seedSearch(transactions: Transaction[]) {
  queryClient.setQueryData<TransactionSearchResult>(SEARCH_KEY, { transactions, truncated: false });
}
function searchRow(id = 'deep1'): Transaction | undefined {
  return queryClient.getQueryData<TransactionSearchResult>(SEARCH_KEY)?.transactions.find((t) => t.transaction_id === id);
}
function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((call: unknown[]) => (call[0] as { queryKey: string[] }).queryKey[0]);
}

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 'deep1', category: 'groceries' });
  mockApi.deleteCategory.mockResolvedValue({ id: 'groceries' });
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
});
afterEach(() => { queryClient.clear(); });

function mount() {
  return renderHook(() => useAppContext(), { wrapper }).result;
}

it('[1] files a deep-history row that lives ONLY in a search result', async () => {
  seedSearch([txn()]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 'deep1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('one'); });

  expect(mockApi.setTransactionCategory).toHaveBeenCalledWith('deep1', 'groceries');
});

it('[2] patches the filed row inside the search result', async () => {
  seedSearch([txn()]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 'deep1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('one'); });

  expect(searchRow()?.category).toBe('groceries');
});

it('[3] "every charge from this shop" also files the same shop\'s unfiled search-only rows', async () => {
  mockApi.setTransactionCategories.mockResolvedValue({ results: [
    { id: 'deep1', status: 'updated' }, { id: 'deep2', status: 'updated' },
  ] } as never);
  seedSearch([txn(), txn({ transaction_id: 'deep2', date: '2019-05-01' })]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 'deep1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('all'); });

  expect(searchRow('deep2')?.category).toBe('groceries');
});

it('[4] a notes edit lands in the search result', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'deep1', notes: 'birthday' });
  seedSearch([txn()]);
  const result = mount();

  await act(async () => { await result.current.applyTransactionEdit('deep1', { notes: 'birthday' }); });

  expect(searchRow()?.notes).toBe('birthday');
});

it('[5] filing several at once (bulk re-categorise) lands in the search result', async () => {
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 'deep1', status: 'updated' }] } as never);
  seedSearch([txn()]);
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(['deep1'], 'groceries'); });

  expect(searchRow()?.category).toBe('groceries');
});

it('[6] deleting a category refreshes search results', async () => {
  seedSearch([txn({ category: 'groceries' })]);
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteCategory('groceries'); });

  expect(invalidatedKeys(spy)).toContain('transactionsSearch');
  expect(searchRow()?.category).toBeNull(); // the delete cascade patched it too
  spy.mockRestore();
});

it('[7] renaming a category refreshes search results (the name is searchable text)', async () => {
  mockApi.updateCategory.mockResolvedValue({ ...CAT, name: 'Food shop' } as never);
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.saveCategory('groceries', { name: 'Food shop', bucket: 'Living', icon: 'cart' }); });

  expect(invalidatedKeys(spy)).toContain('transactionsSearch');
  spy.mockRestore();
});
