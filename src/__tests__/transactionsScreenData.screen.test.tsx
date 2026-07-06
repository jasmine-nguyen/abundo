// WHIT-190a — useTransactionsScreenData composite (gaps): the refetchStale isStale
// gate (instant-from-cache on revisit → focus refetches ONLY stale queries) and the
// isError OR across BOTH the transactions and categories reads. Real QueryClient +
// renderHook; ../api + ../auth mocked. Fail-on-revert: dropping the `if (...isStale)`
// guard makes the fresh-cache case refetch (count → 2); dropping categoriesQuery.isError
// from the OR makes the categories-only-failure case report isError:false.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFetchTransactions = jest.fn<() => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchTransactions: () => mockFetchTransactions(),
  fetchCategories: () => mockFetchCategories(),
}));

import { useTransactionsScreenData } from '../queries';

const CATS = [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 }];
const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

function makeClient(staleTime: number) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  mockFetchTransactions.mockReset().mockResolvedValue(TXNS);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
});

it('refetchStale no-ops on a FRESH cache (instant-from-cache on revisit)', async () => {
  const client = makeClient(Infinity); // never stale
  const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
  await waitFor(() => expect(result.current.transactions.length).toBe(1));
  expect(mockFetchTransactions).toHaveBeenCalledTimes(1);

  act(() => { result.current.refetchStale(); });
  await act(async () => { await Promise.resolve(); }); // flush any (non-)refetch microtask
  expect(mockFetchTransactions).toHaveBeenCalledTimes(1); // fresh → no refetch
  expect(mockFetchCategories).toHaveBeenCalledTimes(1);
});

it('refetchStale REFETCHES a STALE cache (focus refresh)', async () => {
  const client = makeClient(0); // immediately stale
  const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
  await waitFor(() => expect(result.current.transactions.length).toBe(1));
  expect(mockFetchTransactions).toHaveBeenCalledTimes(1);

  await act(async () => { result.current.refetchStale(); });
  await waitFor(() => expect(mockFetchTransactions).toHaveBeenCalledTimes(2));
});

it('isError surfaces when ONLY the categories read fails (transactions still populated)', async () => {
  mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
  const client = makeClient(Infinity); // retry:false
  const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.transactions.length).toBe(1); // tx loaded despite categories failing
});
