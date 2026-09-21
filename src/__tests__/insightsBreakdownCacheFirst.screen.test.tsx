// WHIT-194 GAP (cache-first on the BREAKDOWN side, uncat-only) — authored by qa, reworked
// by the implementer into a HOOK-level lock (renderHook) after the original screen-level
// version proved toothless: `client.refetchQueries` moves the query CACHE to status:error,
// but the React observer had not flushed that into the render before the synchronous
// assert, so the screen never saw isError and the test passed for the wrong reason. The
// deterministic property this locks: a BREAKDOWN background-refetch failure surfaces the
// composite isError (v5's error status propagates once the observer re-renders — waitFor'd)
// WHILE the last-good breakdown data is RETAINED (v5 never clears data on a failed refetch),
// and categoriesError stays false because categories never errored. Mirrors the proven
// categories-retention lock in insightsScreenData.edges. The paired SCREEN-level assertion —
// that this isError-with-rows state keeps the row visible and shows no error card — lives in
// insightsScreenGaps (the mocked-composite showError guard), where it is a real fail-on-revert
// lock on `showError`'s `&& rows.length === 0`.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFetchBreakdown = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

import { useInsightsScreenData } from '../queries';
import { UNCATEGORIZED_KEY } from '../context';

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
// An Uncategorized-ONLY cycle — the row that survives with or without taxonomy.
const UNCAT_ONLY = { [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 } };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchBreakdown.mockReset().mockResolvedValue(UNCAT_ONLY);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
});

it('a breakdown background-refetch failure surfaces isError but RETAINS the last-good breakdown (categoriesError stays false)', async () => {
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });
  // First load: the Uncategorized-only cycle is cached from a good breakdown.
  await waitFor(() => expect(result.current.breakdown[UNCATEGORIZED_KEY]?.posted).toBe(25));

  // Only breakdown fails on refetch; categories + payCycle still resolve. Retry fires all.
  mockFetchBreakdown.mockReset().mockRejectedValue(new Error('API error: 503'));
  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.isError).toBe(true)); // the failed breakdown refetch propagates

  // v5 retains the last-good data on a failed refetch → the cached cycle survives...
  expect(result.current.breakdown[UNCATEGORIZED_KEY]?.posted).toBe(25);
  // ...and categories never errored, so this is NOT a first-load taxonomy failure.
  expect(result.current.categoriesError).toBe(false);
});
