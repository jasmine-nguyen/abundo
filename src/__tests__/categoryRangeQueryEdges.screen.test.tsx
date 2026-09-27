// Card 609 QA — the drill-in's date-range cache (the Ask Abundo deep link). A range must cache apart
// from the cycle view AND from other ranges for the same category, and must sit under the
// ['categoryTransactions'] prefix so a re-file (which invalidates that prefix) refreshes it.
// ../api + ../auth mocked; real QueryClientProvider (same pattern as screenQueryHooks).
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

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

const JUN_SEP = { from: '2026-06-12', to: '2026-09-11' };
const JUL_SEP = { from: '2026-07-01', to: '2026-09-11' };

beforeEach(() => {
  // Rows tagged by what was asked for, so a key collision shows up as the wrong rows.
  mockFetchCategoryTransactions.mockReset().mockImplementation((id, cycle, range) =>
    Promise.resolve([{ transaction_id: range ? `${id}-${range.from}` : `${id}-c${cycle}` }]));
});

it('[A25] a range caches apart from the cycle view and from another range', async () => {
  const client = makeClient();
  const cycle = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true), { wrapper: wrapper(client) });
  const jun = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, JUN_SEP), { wrapper: wrapper(client) });
  const jul = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, JUL_SEP), { wrapper: wrapper(client) });

  await waitFor(() => expect(jul.result.current.data).toBeDefined());
  await waitFor(() => expect(jun.result.current.data).toBeDefined());
  await waitFor(() => expect(cycle.result.current.data).toBeDefined());
  expect(cycle.result.current.data).toEqual([{ transaction_id: 'coffee-c0' }]);
  expect(jun.result.current.data).toEqual([{ transaction_id: 'coffee-2026-06-12' }]);
  expect(jul.result.current.data).toEqual([{ transaction_id: 'coffee-2026-07-01' }]);
});

it('[A26] invalidating the categoryTransactions prefix refetches a range query', async () => {
  const client = makeClient();
  const jun = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, JUN_SEP), { wrapper: wrapper(client) });
  await waitFor(() => expect(jun.result.current.data).toBeDefined());
  expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(1);

  await act(async () => { await client.invalidateQueries({ queryKey: categoryTransactionsKey }); });
  await waitFor(() => expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(2));
  expect(mockFetchCategoryTransactions).toHaveBeenLastCalledWith('coffee', 0, JUN_SEP);
});
