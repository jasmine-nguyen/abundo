// WHIT-367 GAP — useCategoryTransactionsScreenData (src/queries.ts:667): the drill-in composite
// that feeds `categoriesReady` to app/category/[id].tsx. The screen tests mock this hook, so they
// can't prove the FLAG itself is derived right from a real cache. These do, over a real
// QueryClient (../api + ../auth mocked, mirroring categoryDrillQuery.gaps / screenQueryHooks):
//   [A-warm] (P0) categories already cached (drilled from Insights) → categoriesReady TRUE on the
//            first render — no extra cold spinner on the warm path.
//   [A-cold] (P0) categories still in flight → categoriesReady FALSE first, then TRUE once loaded.
//   [A-empty] (P1) an empty taxonomy `[]` is "loaded" → categoriesReady TRUE, no crash.
//   [A-err]  (P0) categories read fails while transactions are cached → isError TRUE +
//            categoriesReady FALSE (so the screen shows error+retry, NOT a cold "$0" detail).
//   [A-retry] (P0) refetch re-fires BOTH the transactions AND the categories reads.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchCategoryTransactions = jest.fn<(id: string, cycle: number) => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchCategoryTransactions: (id: string, cycle: number) => mockFetchCategoryTransactions(id, cycle),
}));

import { useCategoryTransactionsScreenData, categoriesKey } from '../queries';

const CATS = [{ id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#2ac3de', recent: 0 }];
const ROWS = [{ transaction_id: 'salary-c0' }];

function makeClient(staleTime = 60_000) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchCategoryTransactions.mockReset().mockResolvedValue(ROWS);
});

// [A-warm] — the warm path: Insights already loaded the taxonomy, so drilling in must NOT flash a
// spinner. Pre-seed the categories cache, then the FIRST synchronous render already has
// categoriesReady === true. FAIL-ON-REVERT: hard-coding categoriesReady to false makes this fail.
it('categoriesReady is true on the first render when the taxonomy is already cached', async () => {
  const client = makeClient();
  client.setQueryData(categoriesKey, CATS); // taxonomy warmed by an earlier screen
  const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(client) });
  expect(result.current.categoriesReady).toBe(true);        // warm on mount → no cold gate
  expect(result.current.category('salary')?.bucket).toBe('Income');
  await waitFor(() => expect(result.current.transactions).toHaveLength(1)); // flush the txn fetch
});

// [A-cold] — the cold path the fix exists for: taxonomy in flight → categoriesReady false first
// (the screen holds the spinner), then true once it lands. FAIL-ON-REVERT: hard-coding true skips
// the false phase and this first assertion fails.
it('categoriesReady is false while the taxonomy loads, then true once it lands', async () => {
  const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
  expect(result.current.categoriesReady).toBe(false);       // cold: categories still fetching
  await waitFor(() => expect(result.current.categoriesReady).toBe(true));
});

// [A-empty] — an empty taxonomy is still "loaded" (data === []), so categoriesReady must be true
// and the screen renders (everything Uncategorized), not stall on a spinner forever. No crash.
it('treats an empty taxonomy ([]) as ready (true), not as never-loaded', async () => {
  mockFetchCategories.mockReset().mockResolvedValue([]);
  const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.categoriesReady).toBe(true));
  expect(result.current.category('salary')).toBeUndefined(); // empty taxonomy → no match, no throw
});

// [A-err] — the categories-error-with-cached-transactions path: transactions resolve but the
// taxonomy read fails. isError must be true and categoriesReady false, so the screen shows the
// error card (it can't label/sign the rows) instead of a cold "$0" detail.
it('a taxonomy read failure (transactions cached) surfaces isError with categoriesReady false', async () => {
  mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.categoriesReady).toBe(false);       // never loaded → screen must gate
  expect(result.current.transactions).toHaveLength(1);       // the txns DID land
  expect(result.current.isLoading).toBe(false);              // errored dep → not a stranded spinner
});

// [A-retry] — the inline Retry (refetch) must re-fire BOTH reads, so a taxonomy failure can
// actually recover. FAIL-ON-REVERT: dropping categoriesQuery from useCombineScreenQueries' array
// leaves fetchCategories at 1 call.
it('refetch re-fires both the transactions and the categories reads', async () => {
  const { result } = renderHook(() => useCategoryTransactionsScreenData('salary', 0), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(1);
  expect(mockFetchCategories).toHaveBeenCalledTimes(1);

  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(mockFetchCategoryTransactions).toHaveBeenCalledTimes(2));
  expect(mockFetchCategories).toHaveBeenCalledTimes(2);       // BOTH reads re-fired
});
