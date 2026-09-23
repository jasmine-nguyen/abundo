// WHIT-576 — QA gap tests for refresh-on-return (queries.ts refetchStale) while a search is active.
// transactionsSearchQueries locks pull-to-refresh; these lock the FOCUS path:
//   [A8] a stale search (e.g. a new charge landed since) is re-asked on return; the paged feed is
//        left alone (refetching every loaded page under a search would be a wasted storm).
//   [A9] a fresh search is NOT re-asked on return.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transaction } from '../context';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFeed = jest.fn<(cursor?: string) => Promise<unknown>>();
const mockSearch = jest.fn<(tab: string, query: string) => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchTransactionsFeed: (cursor?: string) => mockFeed(cursor),
  fetchUncategorizedFeed: () => Promise.resolve({ transactions: [], nextCursor: null }),
  fetchTransactionsSearch: (tab: string, query: string) => mockSearch(tab, query),
  fetchTransactions: () => Promise.resolve([]),
  fetchCategories: () => Promise.resolve([]),
  fetchAccountBalances: () => Promise.resolve([]),
}));

import { useTransactionsScreenData } from '../queries';

const tx = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
});
const ids = (list: Transaction[]) => list.map((transaction) => transaction.transaction_id);
const client = (staleTime: number) =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
const mount = (queryClient: QueryClient) => renderHook(() => useTransactionsScreenData('all', 'steven'), {
  wrapper: ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children),
});

beforeEach(() => {
  mockFeed.mockReset().mockResolvedValue({ transactions: [tx('feed1')], nextCursor: 'more' });
  mockSearch.mockReset().mockResolvedValue({ transactions: [tx('old-match')], truncated: false });
});

it('[A8] on return, a stale search is re-asked (and picks up a new match); the feed is not refetched', async () => {
  const { result } = mount(client(0)); // everything is immediately stale
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  await waitFor(() => expect(mockFeed).toHaveBeenCalled());
  mockFeed.mockClear();
  mockSearch.mockClear().mockResolvedValue({ transactions: [tx('new-charge'), tx('old-match')], truncated: false });

  await act(async () => { result.current.refetchStale(); });

  await waitFor(() => expect(ids(result.current.search.results)).toEqual(['new-charge', 'old-match']));
  expect(mockSearch).toHaveBeenCalledWith('all', 'steven');
  expect(mockFeed).not.toHaveBeenCalled();
});

it('[A9] on return, a fresh search is not re-asked', async () => {
  const { result } = mount(client(60_000));
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  mockSearch.mockClear();

  await act(async () => { result.current.refetchStale(); });

  expect(mockSearch).not.toHaveBeenCalled();
});
