// WHIT-204 GAP (composite) — the Insights status array's payCycle membership, which no
// existing test locks (Budgets has the equivalent lock in screenQueryHooks/budgetsQueryGaps;
// Insights did not). Insights windows its breakdown on payCycleQuery.isSuccess, so a
// pay-cycle failure leaves breakdown DISABLED (isPending:true, isLoading:false). If payCycle
// were dropped from useCombineScreenQueries([...]), a pay-cycle outage would surface neither
// isError (nothing to OR) nor isLoading — stranding the user on an empty screen with no Retry.
// Fail-on-revert: dropping payCycleQuery from the Insights array flips isError to false here.
// ../api + ../auth mocked; real QueryClientProvider drives the hook (mirrors goalScreenData.edges).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFetchBreakdown = jest.fn<(days: number, cycle?: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
const mockFetchBudgets = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number, number?])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
  fetchBudgets: () => mockFetchBudgets(),
}));

import { useInsightsScreenData } from '../queries';

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchBreakdown.mockReset().mockResolvedValue(BREAKDOWN);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
  mockFetchBudgets.mockReset().mockResolvedValue({}); // no budgets by default
});

it('a payCycle failure surfaces as isError and does NOT strand isLoading (payCycle IS in the Insights array)', async () => {
  mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.isError).toBe(true)); // payCycleQuery IS in the OR
  expect(result.current.isLoading).toBe(false);                   // errored dependency → inline error, not a forever spinner
  // WHIT-72: breakdown no longer waits behind payCycleQuery.isSuccess — it fetches in parallel
  // with the default length (the server derives the window itself), so it DID fetch. The
  // composite still surfaces isError via the payCycle failure in the OR.
  await waitFor(() => expect(mockFetchBreakdown).toHaveBeenCalledWith(14, 0)); // WHIT-68: current cycle = 0
});

// WHIT-194: the categoriesError signal that lets Insights distinguish a first-load categories
// failure (no taxonomy → show the error) from a background-refetch failure over good cached
// taxonomy (keep the rows). These two lock the `data === undefined` guard — the make-or-break.
it('categoriesError is TRUE on a FIRST-LOAD categories failure (never-succeeded → data undefined)', async () => {
  mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.categoriesError).toBe(true); // categories errored AND never had data
  expect(result.current.category('coffee')).toBeUndefined(); // no taxonomy to label rows
});

it('categoriesError is FALSE on a BACKGROUND-refetch categories failure over good cache (cache-first preserved)', async () => {
  // First load succeeds → taxonomy cached. Then a refetch of categories fails: TanStack v5
  // RETAINS the last-good data, so categoriesError must stay false and the taxonomy survives —
  // the exact regression a bare `.isError` (no data guard) would introduce.
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.category('coffee')?.name).toBe('Cafes & Coffee'));

  mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 503'));
  await act(async () => { result.current.refetch(); });
  await waitFor(() => expect(result.current.isError).toBe(true)); // the failed categories refetch propagates

  expect(result.current.categoriesError).toBe(false);            // <-- data retained → NOT a first-load error
  expect(result.current.category('coffee')?.name).toBe('Cafes & Coffee'); // last-good taxonomy still labels rows
});

// WHIT-312: `earned` rides in the breakdown response's __earned__ bucket (server-computed),
// read as posted + pending; absent (no income, or an older server) → 0.
it('derives earned from the __earned__ bucket (posted + pending)', async () => {
  mockFetchBreakdown.mockReset().mockResolvedValue({ coffee: { posted: 40, pending: 10 }, __earned__: { posted: 2500, pending: 300 } });
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.earned).toBe(2800));
  // The earned bucket must not leak into the spend breakdown consumers keep reading.
  expect(result.current.breakdown.coffee).toEqual({ posted: 40, pending: 10 });
});

it('earned defaults to 0 when the response carries no __earned__ (older server / no income)', async () => {
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.breakdown.coffee).toBeTruthy());
  expect(result.current.earned).toBe(0);
});

// WHIT-312 (qa gap): switching cycle must RE-DERIVE earned from that cycle's own cached
// breakdown — never carry the previous cycle's __earned__. breakdownQuery is cycle-keyed, so
// the hook reads a different cache entry per cycle. Fail-on-revert: if `earned` were computed
// off a stale/shared source, cycle=1 would keep cycle=0's 2800.
// [A14]
it('re-derives earned from the selected cycle (no stale carry-over on cycle switch)', async () => {
  mockFetchBreakdown.mockReset().mockImplementation((_days: number, cycle?: number) =>
    Promise.resolve(cycle === 1
      ? { coffee: { posted: 5, pending: 0 }, __earned__: { posted: 1000, pending: 0 } }
      : { coffee: { posted: 40, pending: 10 }, __earned__: { posted: 2500, pending: 300 } }));

  const client = makeClient();
  const { result, rerender } = renderHook(({ cycle }: { cycle: number }) => useInsightsScreenData(cycle), {
    initialProps: { cycle: 0 },
    wrapper: wrapper(client),
  });
  await waitFor(() => expect(result.current.earned).toBe(2800)); // this cycle: 2500 + 300

  rerender({ cycle: 1 });
  await waitFor(() => expect(result.current.earned).toBe(1000)); // last cycle: its OWN __earned__
  expect(result.current.breakdown.coffee).toEqual({ posted: 5, pending: 0 });
});
