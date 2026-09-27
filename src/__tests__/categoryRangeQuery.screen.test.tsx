// Card 609 QA — the drill-in's date-range query (the Ask Abundo deep link). The range must cache
// apart from the cycle view, and still sit under the categoryTransactions prefix so a categorise
// write's prefix invalidation refreshes it. ../api + ../auth mocked; real QueryClient.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

type Range = { from: string; to: string } | undefined;
const mockFetchCategoryTransactions = jest.fn<(id: string, cycle: number, range?: Range) => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategoryTransactions: (id: string, cycle: number, range?: Range) => mockFetchCategoryTransactions(id, cycle, range),
}));

import { useCategoryCycleTransactionsQuery, categoryTransactionsKey } from '../queries';

const RANGE = { from: '2026-06-12', to: '2026-09-11' };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchCategoryTransactions.mockReset().mockImplementation((id, cycle, range) =>
    Promise.resolve([{ transaction_id: range ? `${id}-${range.from}` : `${id}-c${cycle}` }]));
});

// [A13]
it('a date range caches apart from the cycle view of the same category', async () => {
  const client = makeClient();
  const cycle = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true), { wrapper: wrapper(client) });
  const range = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, RANGE), { wrapper: wrapper(client) });

  await waitFor(() => expect(cycle.result.current.data).toBeDefined());
  await waitFor(() => expect(range.result.current.data).toBeDefined());
  expect(cycle.result.current.data).toEqual([{ transaction_id: 'coffee-c0' }]);
  expect(range.result.current.data).toEqual([{ transaction_id: 'coffee-2026-06-12' }]);
  expect(mockFetchCategoryTransactions).toHaveBeenCalledWith('coffee', 0, RANGE);
});

// [A14]
it('invalidating the categoryTransactions prefix refetches the date-range list', async () => {
  const client = makeClient();
  const range = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, RANGE), { wrapper: wrapper(client) });
  await waitFor(() => expect(range.result.current.data).toBeDefined());
  expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(1);

  await act(async () => { await client.invalidateQueries({ queryKey: categoryTransactionsKey }); });
  expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(2);
});
