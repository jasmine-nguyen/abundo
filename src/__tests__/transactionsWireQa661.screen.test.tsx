// WHIT-661 QA — the exact requests the Transactions search and feeds send, now that the real ../api
// runs over the fake server. The moved suites seed one reply per path, so none of them proves the
// Uncategorized tab sends its own tab, or that typed text and cursors are URL-encoded.
// Real ../api over the fake server; ../auth mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { makeClient, wrapper } from './support/queryClient';
import type { Transaction } from '../types';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));

import { useTransactionsScreenData, useTransactionsFeedQuery, useUncategorizedFeedQuery } from '../queries';

const server = installFakeServer();
const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const SEARCH = '/transactions/search';

const tx = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
});
const ids = (list: Transaction[]) => list.map((transaction) => transaction.transaction_id);

beforeEach(() => {
  server.seed(FEED, { transactions: [tx('feed1')], nextCursor: null });
});

function mountScreenData(tab: 'all' | 'uncategorized', query: string) {
  return renderHook(() => useTransactionsScreenData(tab, query), { wrapper: wrapper(makeClient()) });
}

// [A1]
it('a search on the Uncategorized tab asks the server for that tab, not All', async () => {
  server.seed(SEARCH, { transactions: [tx('unfiled-steven')], truncated: false });
  const { result } = mountScreenData('uncategorized', 'steven');

  await waitFor(() => expect(result.current.search.answered).toBe(true));
  expect(server.sent('GET', '/transactions/search?tab=uncategorized&q=steven')).toHaveLength(1);
  expect(server.sent('GET', '/transactions/search?tab=all&q=steven')).toHaveLength(0);
  expect(ids(result.current.search.results)).toEqual(['unfiled-steven']);
});

// [A2]
it('typed search text with spaces and & is URL-encoded, so it reaches the server whole', async () => {
  server.seed(SEARCH, { transactions: [tx('match')], truncated: false });
  const { result } = mountScreenData('all', 'coffee & tea');

  await waitFor(() => expect(result.current.search.answered).toBe(true));
  expect(server.sentUnder('GET', SEARCH).map((request) => request.path)).toEqual([
    '/transactions/search?tab=all&q=coffee%20%26%20tea',
  ]);
});

// [A3]
it('a search the server rejects (500) reports an error with no matches', async () => {
  server.fail(SEARCH, 500);
  const { result } = mountScreenData('all', 'steven');

  await waitFor(() => expect(result.current.search.isError).toBe(true));
  expect(result.current.search.results).toEqual([]);
  expect(result.current.search.answered).toBe(false);
  expect(ids(result.current.transactions)).toEqual(['feed1']); // the feed underneath is untouched
});

// [A4]
it('Load More on the feed sends the previous page\'s cursor URL-encoded', async () => {
  server.once('GET', FEED, { body: { transactions: [tx('p1')], nextCursor: 'a/b+c=' } });
  server.once('GET', FEED, { body: { transactions: [tx('p2')], nextCursor: null } });
  const { result } = renderHook(() => useTransactionsFeedQuery(true), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.hasNextPage).toBe(true));

  await act(async () => { await result.current.fetchNextPage(); });

  expect(server.sentUnder('GET', FEED).map((request) => request.path)).toEqual([
    FEED,
    '/transactions/feed?cursor=a%2Fb%2Bc%3D',
  ]);
  await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  expect(result.current.data?.pages.flatMap((page) => ids(page.transactions))).toEqual(['p1', 'p2']);
});

// [A5]
it('Load More on the Uncategorized feed sends its cursor URL-encoded, on its own path', async () => {
  server.once('GET', UNCATEGORIZED_FEED, { body: { transactions: [], nextCursor: 'deep/cursor+1' } });
  server.once('GET', UNCATEGORIZED_FEED, { body: { transactions: [tx('u2')], nextCursor: null } });
  const { result } = renderHook(() => useUncategorizedFeedQuery(true), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.hasNextPage).toBe(true)); // an empty page with a cursor keeps going

  await act(async () => { await result.current.fetchNextPage(); });

  expect(server.sentUnder('GET', UNCATEGORIZED_FEED).map((request) => request.path)).toEqual([
    UNCATEGORIZED_FEED,
    '/transactions/uncategorized/feed?cursor=deep%2Fcursor%2B1',
  ]);
  expect(server.sentUnder('GET', FEED)).toHaveLength(0);
  await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  expect(result.current.data?.pages.flatMap((page) => ids(page.transactions))).toEqual(['u2']);
});
