// WHIT-627 — re-filing charges through the real AppProvider against a seeded cache, checked by
// what each saved copy shows afterwards (no spying on refresh calls). One batch re-file where one
// charge fails to save: the saved ones show the new category everywhere, the failed one is back to
// its old category, the old budget's list keeps only the failed one, and the right lists are
// marked for a refresh (search is patched in place, so it is not). The lookup then finds the
// fresh copy, not the stale one in the category drill-in list.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import type { InfiniteData } from '@tanstack/react-query';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category } from '../types';
import type { TransactionFeedPage, TransactionSearchResult } from '../api';
import { queryClient } from '../queryClient';
import { findTransaction } from '../transactionCache';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {}, getAuthToken: async () => 'test-id-token' }));
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CATEGORIES: Category[] = [
  { id: 'dining', name: 'Dining', bucket: 'Living', icon: 'food', color: '#f00', recent: 0, parent: null },
  { ...GROCERIES_RECORD, color: '#0f0', recent: 0, parent: null },
];
const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: 'dining', status: 'posted', type: 'PAYMENT', counts_to_budget: true, ...over,
});
const page = (transactions: Transaction[]) => ({ pages: [{ transactions, nextCursor: null }], pageParams: [undefined] });

const SEARCH_KEY = ['transactionsSearch', 'all', 'coles'];
const BUDGET_KEY = ['budgetTransactions', 'dining'];
const CATEGORY_KEY = ['categoryTransactions', 'dining', 0];

function seed() {
  queryClient.setQueryData(['categories'], CATEGORIES);
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2'), tx('t3', { category: null })]));
  queryClient.setQueryData(['uncategorizedFeed'], page([tx('t3', { category: null })]));
  queryClient.setQueryData(['transactionsRecent'], [tx('t1'), tx('t2')]);
  queryClient.setQueryData(SEARCH_KEY, { transactions: [tx('t2'), tx('t1')], truncated: false });
  queryClient.setQueryData(BUDGET_KEY, [tx('t1'), tx('t2')]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('t1'), tx('t2')]);
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData(['breakdown', 14, 0], {});
  queryClient.setQueryData(['uncategorizedCount'], 1);
}

const categoryOf = (rows: Transaction[] | undefined) =>
  Object.fromEntries((rows ?? []).map((t) => [t.transaction_id, t.category]));
const feedRows = (key: string) =>
  queryClient.getQueryData<InfiniteData<TransactionFeedPage>>([key])?.pages.flatMap((p) => p.transactions);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('a batch re-file updates every copy, undoes only the charge that failed, and refreshes the right lists', async () => {
  // t2's save fails; t1 and t3 save.
  server.once('PATCH', '/transactions', {
    body: { results: [{ id: 't1', status: 'updated' }, { id: 't3', status: 'updated' }] },
  });
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2', 't3'], 'groceries'); });

  expect(categoryOf(feedRows('transactions'))).toEqual({ t1: 'groceries', t2: 'dining', t3: 'groceries' });
  expect(categoryOf(feedRows('uncategorizedFeed'))).toEqual({ t3: 'groceries' });
  expect(categoryOf(queryClient.getQueryData<Transaction[]>(['transactionsRecent']))).toEqual({ t1: 'groceries', t2: 'dining' });
  expect(categoryOf(queryClient.getQueryData<TransactionSearchResult>(SEARCH_KEY)?.transactions))
    .toEqual({ t2: 'dining', t1: 'groceries' });

  // The old budget's list drops the saved charge but keeps the one that failed.
  expect(queryClient.getQueryData<Transaction[]>(BUDGET_KEY)?.map((t) => t.transaction_id)).toEqual(['t2']);

  // Marked for a refresh: the server-derived totals and the budget/category lists.
  expect(queryClient.getQueryState(['budgets', 14])?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(['breakdown', 14, 0])?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(BUDGET_KEY)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(CATEGORY_KEY)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(['uncategorizedCount'])?.isInvalidated).toBe(true);
  // Search was patched in place, so it is not refetched.
  expect(queryClient.getQueryState(SEARCH_KEY)?.isInvalidated).toBe(false);

  // The lookup sees the fresh copy, not the stale one left in the category drill-in list.
  expect(findTransaction('t1', { includeScopedLists: true })?.category).toBe('groceries');
  expect(findTransaction('t2', { includeScopedLists: true })?.category).toBe('dining');
});
