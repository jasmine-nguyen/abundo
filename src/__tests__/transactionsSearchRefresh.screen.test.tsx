// WHIT-576 — QA gap tests for refresh-on-return (queries.ts refetchStale) while a search is active.
// transactionsSearchQueries locks pull-to-refresh; these lock the FOCUS path:
//   [A8] a stale search (e.g. a new charge landed since) is re-asked on return; the paged feed is
//        left alone (refetching every loaded page under a search would be a wasted storm).
//   [A9] a fresh search is NOT re-asked on return.
// Real ../api over the fake server; ../auth mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import type { Transaction } from '../context';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));

import { useTransactionsScreenData } from '../queries';

const server = installFakeServer();
const SEARCH = '/transactions/search?tab=all&q=steven';

const tx = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
});
const ids = (list: Transaction[]) => list.map((transaction) => transaction.transaction_id);
const mount = (queryClient: QueryClient) =>
  renderHook(() => useTransactionsScreenData('all', 'steven'), { wrapper: wrapper(queryClient) });

beforeEach(() => {
  server.seed('/transactions/feed', { transactions: [tx('feed1')], nextCursor: 'more' });
  server.seed('/transactions/search', { transactions: [tx('old-match')], truncated: false });
});

it('[A8] on return, a stale search is re-asked (and picks up a new match); the feed is not refetched', async () => {
  const { result } = mount(makeClient({ staleTime: 0 })); // everything is immediately stale
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  await waitFor(() => expect(server.sentUnder('GET', '/transactions/feed').length).toBeGreaterThan(0));
  const feedCalls = server.sentUnder('GET', '/transactions/feed').length;
  const searchCalls = server.sent('GET', SEARCH).length;
  server.seed('/transactions/search', { transactions: [tx('new-charge'), tx('old-match')], truncated: false });

  await act(async () => { result.current.refetchStale(); });

  await waitFor(() => expect(ids(result.current.search.results)).toEqual(['new-charge', 'old-match']));
  expect(server.sent('GET', SEARCH).length).toBeGreaterThan(searchCalls);
  expect(server.sentUnder('GET', '/transactions/feed')).toHaveLength(feedCalls);
});

it('[A9] on return, a fresh search is not re-asked', async () => {
  const { result } = mount(makeClient());
  await waitFor(() => expect(result.current.search.answered).toBe(true));
  const searchCalls = server.sent('GET', SEARCH).length;

  await act(async () => { result.current.refetchStale(); });

  expect(server.sent('GET', SEARCH)).toHaveLength(searchCalls);
});
