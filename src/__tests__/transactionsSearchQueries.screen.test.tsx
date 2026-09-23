// WHIT-576 — the query-layer half of the full-history search (queries.ts):
//   [Q1] useTransactionsScreenData(tab, query) runs the search for that tab + query, and keeps
//        `transactions` as the NORMAL feed (the badge's local fallback count reads it).
//   [Q2] `answered` is false while the previous query's result is only a placeholder.
//   [Q3] a placeholder is never carried across tabs (no Uncategorized matches on All).
//   [Q4] pull-to-refresh under a search refetches the SEARCH, not the feed — unless the feed failed.
//   [Q5] useTransactionResolver finds a row that lives only in a search result, and picks up a
//        patch to it (the picker/confirm sheets resolve through this).
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

import { useTransactionsScreenData, useTransactionResolver } from '../queries';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
});
const ids = (list: Transaction[]) => list.map((transaction) => transaction.transaction_id);
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
const wrapper = (client: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client }, children);
type Props = { tab: 'all' | 'uncategorized'; query: string };

beforeEach(() => {
  mockFeed.mockReset().mockResolvedValue({ transactions: [tx('feed1')], nextCursor: 'more' });
  mockSearch.mockReset().mockImplementation((tab, query) =>
    Promise.resolve({ transactions: [tx(`${tab}-${query}`)], truncated: false }));
});

function mountScreenData(client: QueryClient, initialProps: Props) {
  return renderHook(({ tab, query }: Props) => useTransactionsScreenData(tab, query), {
    wrapper: wrapper(client), initialProps,
  });
}

it('[Q1] searches the tab + query and leaves `transactions` as the normal feed', async () => {
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });

  await waitFor(() => expect(result.current.search.answered).toBe(true));
  expect(mockSearch).toHaveBeenCalledWith('all', 'steven');
  expect(ids(result.current.search.results)).toEqual(['all-steven']);
  expect(ids(result.current.transactions)).toEqual(['feed1']);
});

it('an empty query runs no search and reports it inactive', async () => {
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: '' });

  await waitFor(() => expect(ids(result.current.transactions)).toEqual(['feed1']));
  expect(mockSearch).not.toHaveBeenCalled();
  expect(result.current.search.active).toBe(false);
  expect(result.current.search.answered).toBe(false);
});

it('[Q2] the previous query\'s result is a placeholder, not an answer, while the next loads', async () => {
  let resolveNext: (value: unknown) => void = () => {};
  const { result, rerender } = mountScreenData(makeClient(), { tab: 'all', query: 'ste' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));

  mockSearch.mockImplementation(() => new Promise((resolve) => { resolveNext = resolve; }));
  rerender({ tab: 'all', query: 'steven' });

  await waitFor(() => expect(mockSearch).toHaveBeenLastCalledWith('all', 'steven'));
  expect(ids(result.current.search.results)).toEqual(['all-ste']); // shown while loading
  expect(result.current.search.answered).toBe(false);
  await act(async () => { resolveNext({ transactions: [tx('all-steven')], truncated: true }); });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  expect(result.current.search.truncated).toBe(true);
});

it('[Q3] never carries one tab\'s results onto the other tab as a placeholder', async () => {
  const { result, rerender } = mountScreenData(makeClient(), { tab: 'uncategorized', query: 'steven' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));

  mockSearch.mockImplementation(() => new Promise(() => {}));
  rerender({ tab: 'all', query: 'steven' });

  await waitFor(() => expect(mockSearch).toHaveBeenLastCalledWith('all', 'steven'));
  expect(result.current.search.results).toEqual([]);
  expect(result.current.search.answered).toBe(false);
});

it('[Q4] pull-to-refresh under a search refetches the search, not the feed', async () => {
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  mockFeed.mockClear();
  mockSearch.mockClear();

  await act(async () => { await result.current.refetchList(); });

  expect(mockSearch).toHaveBeenCalledWith('all', 'steven');
  expect(mockFeed).not.toHaveBeenCalled();
});

it('[Q4b] Retry under a search still reloads a FAILED feed (its error screen hides the search)', async () => {
  mockFeed.mockRejectedValueOnce(new Error('offline'));
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });
  await waitFor(() => expect(result.current.isError).toBe(true));
  mockFeed.mockClear();

  await act(async () => { await result.current.refetchList(); });

  expect(mockFeed).toHaveBeenCalled();
  await waitFor(() => expect(result.current.isError).toBe(false));
});

// A search that already had an answer and then failed a refresh keeps its error flag while a
// manual Retry runs — the screen must show "Searching…", not the stale error.
it('[Q4c] a manual Retry after a failed refresh reports "searching", not the old error', async () => {
  let resolveRetry: (value: unknown) => void = () => {};
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  mockSearch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await result.current.refetchList(); });
  await waitFor(() => expect(result.current.search.isError).toBe(true));

  mockSearch.mockImplementation(() => new Promise((resolve) => { resolveRetry = resolve; }));
  act(() => { result.current.search.retry(); });

  await waitFor(() => expect(result.current.search.isError).toBe(false));
  await act(async () => { resolveRetry({ transactions: [tx('all-steven')], truncated: false }); });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
});

it('[Q5] the resolver finds a search-only row and sees a patch to it', async () => {
  const client = makeClient();
  client.setQueryData(['transactionsSearch', 'all', 'steven'], { transactions: [tx('deep1')], truncated: false });
  const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

  await waitFor(() => expect(result.current.findTx('deep1')).toBeTruthy());
  act(() => {
    client.setQueryData(['transactionsSearch', 'all', 'steven'], { transactions: [tx('deep1', { category: 'groceries' })], truncated: false });
  });
  await waitFor(() => expect(result.current.findTx('deep1')?.category).toBe('groceries'));
});
