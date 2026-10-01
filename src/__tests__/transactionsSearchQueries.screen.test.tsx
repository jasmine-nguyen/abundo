// WHIT-576 — the query-layer half of the full-history search (queries.ts):
//   [Q1] useTransactionsScreenData(tab, query) runs the search for that tab + query, and keeps
//        `transactions` as the NORMAL feed (the badge's local fallback count reads it).
//   [Q2] `answered` is false while the previous query's result is only a placeholder.
//   [Q3] a placeholder is never carried across tabs (no Uncategorized matches on All).
//   [Q4] pull-to-refresh under a search refetches the SEARCH, not the feed — unless the feed failed.
//   [Q5] useTransactionResolver finds a row that lives only in a search result, and picks up a
//        patch to it (the picker/confirm sheets resolve through this).
// Real ../api over the fake server; ../auth mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import type { Transaction } from '../types';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct } from './support/renderWithQueries';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));

import { useTransactionsScreenData, useTransactionResolver } from '../queries';

const server = installFakeServer();
const FEED = '/transactions/feed';
const SEARCH = '/transactions/search';
const ALL_STEVEN = '/transactions/search?tab=all&q=steven';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
});
const ids = (list: Transaction[]) => list.map((transaction) => transaction.transaction_id);
type Props = { tab: 'all' | 'uncategorized'; query: string };

// The pretend server answers one reply per path, so each test seeds the match for the tab + query it mounts with.
const seedSearch = (tab: string, query: string) =>
  server.seed(SEARCH, { transactions: [tx(`${tab}-${query}`)], truncated: false });

beforeEach(() => {
  server.seed(FEED, { transactions: [tx('feed1')], nextCursor: 'more' });
});

function mountScreenData(client: QueryClient, initialProps: Props) {
  return renderHook(({ tab, query }: Props) => useTransactionsScreenData(tab, query), {
    wrapper: wrapper(client), initialProps,
  });
}

it('[Q1] searches the tab + query and leaves `transactions` as the normal feed', async () => {
  seedSearch('all', 'steven');
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });

  await waitFor(() => expect(result.current.search.answered).toBe(true));
  expect(server.sent('GET', ALL_STEVEN).length).toBeGreaterThanOrEqual(1);
  expect(ids(result.current.search.results)).toEqual(['all-steven']);
  expect(ids(result.current.transactions)).toEqual(['feed1']);
});

it('an empty query runs no search and reports it inactive', async () => {
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: '' });

  await waitFor(() => expect(ids(result.current.transactions)).toEqual(['feed1']));
  expect(server.sentUnder('GET', SEARCH)).toHaveLength(0);
  expect(result.current.search.active).toBe(false);
  expect(result.current.search.answered).toBe(false);
});

it('[Q2] the previous query\'s result is a placeholder, not an answer, while the next loads', async () => {
  seedSearch('all', 'ste');
  const { result, rerender } = mountScreenData(makeClient(), { tab: 'all', query: 'ste' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));

  const next = server.hold(SEARCH);
  server.once('GET', SEARCH, { body: { transactions: [tx('all-steven')], truncated: true } });
  rerender({ tab: 'all', query: 'steven' });

  await waitFor(() => expect(server.requests().at(-1)?.path).toBe(ALL_STEVEN));
  expect(ids(result.current.search.results)).toEqual(['all-ste']); // shown while loading
  expect(result.current.search.answered).toBe(false);
  await act(async () => { next.release(); });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  expect(result.current.search.truncated).toBe(true);
});

it('[Q3] never carries one tab\'s results onto the other tab as a placeholder', async () => {
  seedSearch('uncategorized', 'steven');
  const { result, rerender } = mountScreenData(makeClient(), { tab: 'uncategorized', query: 'steven' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));

  const never = server.hold(SEARCH);
  rerender({ tab: 'all', query: 'steven' });

  await waitFor(() => expect(server.requests().at(-1)?.path).toBe(ALL_STEVEN));
  expect(result.current.search.results).toEqual([]);
  expect(result.current.search.answered).toBe(false);
  await act(async () => { never.release(); });
});

it('[Q4] pull-to-refresh under a search refetches the search, not the feed', async () => {
  seedSearch('all', 'steven');
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  const feedCalls = server.sentUnder('GET', FEED).length;
  const searchCalls = server.sent('GET', ALL_STEVEN).length;

  await act(async () => { await result.current.refetchList(); });

  expect(server.sent('GET', ALL_STEVEN).length).toBeGreaterThan(searchCalls);
  expect(server.sentUnder('GET', FEED)).toHaveLength(feedCalls);
});

it('[Q4b] Retry under a search still reloads a FAILED feed (its error screen hides the search)', async () => {
  seedSearch('all', 'steven');
  server.once('GET', FEED, 'dropped');
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });
  await waitFor(() => expect(result.current.isError).toBe(true));
  const feedCalls = server.sentUnder('GET', FEED).length;

  await act(async () => { await result.current.refetchList(); });

  expect(server.sentUnder('GET', FEED).length).toBeGreaterThan(feedCalls);
  await waitFor(() => expect(result.current.isError).toBe(false));
});

it('[Q4d] with rows still on screen, a failed feed refresh does not stop a pull re-asking the search', async () => {
  seedSearch('all', 'steven');
  const client = makeClient();
  const { result } = mountScreenData(client, { tab: 'all', query: 'steven' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  await waitFor(() => expect(ids(result.current.transactions)).toEqual(['feed1']));
  server.once('GET', FEED, 'dropped');
  await refreshInAct(() => client.refetchQueries({ queryKey: ['transactions'] }));
  await waitFor(() => expect(result.current.isError).toBe(true));
  const feedCalls = server.sentUnder('GET', FEED).length;
  const searchCalls = server.sent('GET', ALL_STEVEN).length;

  await act(async () => { await result.current.refetchList(); });

  expect(server.sent('GET', ALL_STEVEN).length).toBeGreaterThan(searchCalls);
  expect(server.sentUnder('GET', FEED)).toHaveLength(feedCalls);
});

// A search that already had an answer and then failed a refresh keeps its error flag while a
// manual Retry runs — the screen must show "Searching…", not the stale error.
it('[Q4c] a manual Retry after a failed refresh reports "searching", not the old error', async () => {
  seedSearch('all', 'steven');
  const { result } = mountScreenData(makeClient(), { tab: 'all', query: 'steven' });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  server.once('GET', SEARCH, 'dropped');
  await act(async () => { await result.current.refetchList(); });
  await waitFor(() => expect(result.current.search.isError).toBe(true));

  const retry = server.hold(SEARCH);
  act(() => { result.current.search.retry(); });

  await waitFor(() => expect(result.current.search.isError).toBe(false));
  await act(async () => { retry.release(); });
  await waitFor(() => expect(result.current.search.answered).toBe(true));
});

it('[Q5] the resolver finds a search-only row and sees a patch to it', async () => {
  const client = makeClient();
  client.setQueryData(['transactionsSearch', 'all', 'steven'], { transactions: [tx('deep1')], truncated: false });
  const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

  await waitFor(() => expect(result.current.findTx('deep1')).toBeTruthy());
  await refreshInAct(() =>
    client.setQueryData(['transactionsSearch', 'all', 'steven'], { transactions: [tx('deep1', { category: 'groceries' })], truncated: false }),
  );
  await waitFor(() => expect(result.current.findTx('deep1')?.category).toBe('groceries'));
});
