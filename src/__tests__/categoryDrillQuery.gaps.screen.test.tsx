// WHIT-342 GAP — useCategoryCycleTransactionsQuery (src/queries.ts): the drill-in's data hook.
//   [A-hook1] does NOT fetch before login (enabled=false)
//   [A-hook2] does NOT fetch when categoryId is empty (the `&& !!categoryId` guard), even authed
//   [A-hook3] the query key includes the cycle, so cycle 0 and cycle 1 for the SAME category cache
//             INDEPENDENTLY — a "this cycle" drill and a "last cycle" drill never serve each other's
//             rows. FAIL-ON-REVERT: dropping `cycle` from the queryKey collides them (both read 0's rows).
//   [A-hook4] fetches with (categoryId, cycle) when enabled + id present.
// ../api + ../auth mocked; real QueryClientProvider. Mirrors screenQueryHooks.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockFetchCategoryTransactions = jest.fn<(id: string, cycle: number) => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategoryTransactions: (id: string, cycle: number) => mockFetchCategoryTransactions(id, cycle),
}));

import { useCategoryCycleTransactionsQuery } from '../queries';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchCategoryTransactions.mockReset()
    // return rows tagged by the cycle asked for, so a key collision would surface as wrong rows.
    .mockImplementation((id, cycle) => Promise.resolve([{ transaction_id: `${id}-c${cycle}` }]));
});

// [A-hook1]
it('does not fetch before login (enabled=false)', () => {
  renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, false), { wrapper: wrapper(makeClient()) });
  expect(mockFetchCategoryTransactions).not.toHaveBeenCalled();
});

// [A-hook2] — the `enabled && !!categoryId` guard: an absent id (a route mounted before params
// resolve) must not fire a `/categories//transactions` request.
it('does not fetch when categoryId is empty, even when enabled', () => {
  renderHook(() => useCategoryCycleTransactionsQuery('', 0, true), { wrapper: wrapper(makeClient()) });
  expect(mockFetchCategoryTransactions).not.toHaveBeenCalled();
});

// [A-hook4]
it('fetches with (categoryId, cycle) when enabled and id present', async () => {
  const { result } = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 1, true), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.data).toBeDefined());
  expect(mockFetchCategoryTransactions).toHaveBeenCalledWith('coffee', 1);
});

// [A-hook3] — the headline cache-key gap: cycle 0 and cycle 1 for the SAME category must not
// collide. Both hooks share ONE client; each must resolve to ITS OWN cycle's rows.
it('caches cycle 0 and cycle 1 independently for the same category (no collision)', async () => {
  const client = makeClient();
  const c0 = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true), { wrapper: wrapper(client) });
  const c1 = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 1, true), { wrapper: wrapper(client) });

  await waitFor(() => expect(c0.result.current.data).toBeDefined());
  await waitFor(() => expect(c1.result.current.data).toBeDefined());

  expect(c0.result.current.data).toEqual([{ transaction_id: 'coffee-c0' }]);
  expect(c1.result.current.data).toEqual([{ transaction_id: 'coffee-c1' }]);
  // both cycles were actually fetched — a collided key would fetch once and share.
  expect(mockFetchCategoryTransactions).toHaveBeenCalledWith('coffee', 0);
  expect(mockFetchCategoryTransactions).toHaveBeenCalledWith('coffee', 1);
});
