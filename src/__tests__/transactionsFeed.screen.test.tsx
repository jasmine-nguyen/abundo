// The Transactions tab feed composite (useTransactionsScreenData) — cursor pagination plus the
// approved "keep history, fast" refresh. Real QueryClient + renderHook; ../api + ../auth mocked.
// Locks: newest page first, Load More appends the next (older) page via the prior cursor,
// hasMore flips false at end-of-history, a manual pull snaps back to the newest page (no N-page
// storm), a focus refresh leaves paged-in history untouched, and the bounded recent hook reads
// its OWN endpoint (Decision 2 — the dot/account counts can't drift with feed depth).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transaction } from '../context';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFeed = jest.fn<(cursor?: string) => Promise<unknown>>();
const mockRecent = jest.fn<() => Promise<unknown>>();
const mockCategories = jest.fn<() => Promise<unknown>>();
const mockBalances = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchTransactionsFeed: (cursor?: string) => mockFeed(cursor),
  fetchTransactions: () => mockRecent(),
  fetchCategories: () => mockCategories(),
  fetchAccountBalances: () => mockBalances(),
}));

import { useTransactionsScreenData, useRecentTransactionsScreenData } from '../queries';

const tx = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
});
const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);

function makeClient(staleTime = 60_000) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  mockFeed.mockReset();
  mockRecent.mockReset().mockResolvedValue([]);
  mockCategories.mockReset().mockResolvedValue([]);
  mockBalances.mockReset().mockResolvedValue([]);
});

it('loads the newest page first, then Load More appends the next (older) page', async () => {
  mockFeed
    .mockResolvedValueOnce({ transactions: [tx('t1'), tx('t2')], nextCursor: 'cur1' })
    .mockResolvedValueOnce({ transactions: [tx('t3')], nextCursor: null });
  const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.transactions.length).toBe(2));
  expect(result.current.hasMore).toBe(true);

  await act(async () => { result.current.loadMore(); });
  await waitFor(() => expect(result.current.transactions.length).toBe(3));
  expect(ids(result.current.transactions)).toEqual(['t1', 't2', 't3']); // appended, order preserved
  expect(result.current.hasMore).toBe(false); // nextCursor null → end of history
  expect(mockFeed).toHaveBeenNthCalledWith(2, 'cur1'); // page 2 fetched with page 1's cursor
});

it('a manual pull SNAPS to the newest page — trims loaded history, refetches page 1 only', async () => {
  mockFeed
    .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' })
    .mockResolvedValueOnce({ transactions: [tx('t2')], nextCursor: 'cur2' }) // page 2
    .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' }); // pull → page 1 fresh
  const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.transactions.length).toBe(1));
  await act(async () => { result.current.loadMore(); });
  await waitFor(() => expect(result.current.transactions.length).toBe(2)); // 2 pages loaded

  await act(async () => { result.current.refetch(); }); // manual pull
  await waitFor(() => expect(ids(result.current.transactions)).toEqual(['t1'])); // snapped to newest
  expect(mockFeed).toHaveBeenLastCalledWith(undefined); // fetched page 1, NOT the accumulated pages
});

it('refetchStale re-checks the loaded pages in place on return, keeping the user place', async () => {
  mockFeed
    .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' })
    .mockResolvedValueOnce({ transactions: [tx('t2')], nextCursor: null })
    // focus refetch re-fetches BOTH loaded pages by their own cursors:
    .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' })
    .mockResolvedValueOnce({ transactions: [tx('t2')], nextCursor: null });
  const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient(0)) }); // stale
  await waitFor(() => expect(result.current.transactions.length).toBe(1));
  await act(async () => { result.current.loadMore(); });
  await waitFor(() => expect(result.current.transactions.length).toBe(2)); // 2 pages
  const callsBefore = mockFeed.mock.calls.length;

  await act(async () => { result.current.refetchStale(); });
  await waitFor(() => expect(mockFeed.mock.calls.length).toBeGreaterThan(callsBefore)); // re-checked the newest
  expect(ids(result.current.transactions)).toEqual(['t1', 't2']); // BOTH pages kept — user's place intact
});

it('the bounded recent hook reads its OWN endpoint, not the feed (Decision 2 separation)', async () => {
  mockFeed.mockResolvedValue({ transactions: [tx('f1')], nextCursor: null });
  mockRecent.mockResolvedValue([tx('r1')]);
  const { result } = renderHook(() => useRecentTransactionsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.transactions.length).toBe(1));
  expect(result.current.transactions[0].transaction_id).toBe('r1'); // from fetchTransactions, not the feed
  expect(mockFeed).not.toHaveBeenCalled(); // the recent hook never touches the feed cache
});
