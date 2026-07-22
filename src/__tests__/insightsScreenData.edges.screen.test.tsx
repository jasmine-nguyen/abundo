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

// WHIT-314: the budgeted overlay data — income vs spend targets, current cycle only.
const BUDGET_CATS = [
  { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 },
  { id: 'salary', name: 'Salary', bucket: 'Income', icon: 'cash', color: '#2ac3de', recent: 0 },
];
const BUDGET_ROLLUPS = {
  coffee: { target: 400, posted: 0, pending: 0 },
  salary: { target: 5000, posted: 0, pending: 0 },
};

it('derives the budgeted income/spend split on the current cycle', async () => {
  mockFetchCategories.mockReset().mockResolvedValue(BUDGET_CATS);
  mockFetchBudgets.mockReset().mockResolvedValue(BUDGET_ROLLUPS);
  const { result } = renderHook(() => useInsightsScreenData(0), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.budgeted).toEqual({ budgetedEarned: 5000, budgetedSpent: 400 }));
});

it('has NO budgeted overlay on a past cycle (budgets have no look-back)', async () => {
  mockFetchCategories.mockReset().mockResolvedValue(BUDGET_CATS);
  mockFetchBudgets.mockReset().mockResolvedValue(BUDGET_ROLLUPS);
  const { result } = renderHook(() => useInsightsScreenData(1), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.breakdown.coffee).toBeTruthy());
  expect(result.current.budgeted).toBeUndefined();
});

it('has NO budgeted overlay when no budgets are set (all-zero totals → undefined)', async () => {
  const { result } = renderHook(() => useInsightsScreenData(0), { wrapper: wrapper(makeClient()) }); // default budgets {}

  await waitFor(() => expect(result.current.breakdown.coffee).toBeTruthy());
  expect(result.current.budgeted).toBeUndefined();
});

// [G12] WHIT-314 GAP — cycle 0→1→0 must not strand a STALE budgeted overlay: it shows on the
// current cycle, disappears on a past cycle (budgets have no look-back), and REAPPEARS when we
// return to the current cycle. Fail-on-revert: a memo that dropped `cycle` from its deps would
// keep the overlay on cycle 1 (or fail to bring it back), and this catches both.
it('[G12] budgeted overlay drops on cycle 1 and reappears on returning to cycle 0 (no stale carry)', async () => {
  mockFetchCategories.mockReset().mockResolvedValue(BUDGET_CATS);
  mockFetchBudgets.mockReset().mockResolvedValue(BUDGET_ROLLUPS);
  const { result, rerender } = renderHook((c: number) => useInsightsScreenData(c), {
    wrapper: wrapper(makeClient()), initialProps: 0,
  });

  await waitFor(() => expect(result.current.budgeted).toEqual({ budgetedEarned: 5000, budgetedSpent: 400 }));
  rerender(1);
  await waitFor(() => expect(result.current.budgeted).toBeUndefined()); // past cycle → no overlay
  rerender(0);
  await waitFor(() => expect(result.current.budgeted).toEqual({ budgetedEarned: 5000, budgetedSpent: 400 })); // back
});

// [G13] WHIT-314 GAP — budgets can resolve AFTER the breakdown paints (secondary query). The
// overlay must APPEAR when budgets land, with no earlier wrong value: `budgeted` is undefined
// while budgets are still in flight (breakdown already resolved), then becomes the totals.
it('[G13] budgeted appears when the (slower) budgets query resolves, undefined until then', async () => {
  mockFetchCategories.mockReset().mockResolvedValue(BUDGET_CATS);
  let resolveBudgets!: (v: unknown) => void;
  mockFetchBudgets.mockReset().mockReturnValue(new Promise((res) => { resolveBudgets = res; }));
  const { result } = renderHook(() => useInsightsScreenData(0), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.breakdown.coffee).toBeTruthy()); // breakdown painted first
  expect(result.current.budgeted).toBeUndefined();                          // budgets still in flight
  await act(async () => { resolveBudgets(BUDGET_ROLLUPS); });
  await waitFor(() => expect(result.current.budgeted).toEqual({ budgetedEarned: 5000, budgetedSpent: 400 }));
});

// [G14] WHIT-314 GAP — a budgets outage on the current cycle must NOT blank the hero: budgets
// are deliberately OUT of the Insights status array, so isError stays false, breakdown+earned
// still render, and the overlay simply goes absent (chart falls back to actuals-only). Fail-on-
// revert: adding budgetsQuery to useCombineScreenQueries flips isError true and breaks this.
it('[G14] a budgets read failure leaves budgeted undefined but keeps the chart + hero (no isError)', async () => {
  mockFetchCategories.mockReset().mockResolvedValue(BUDGET_CATS);
  mockFetchBudgets.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useInsightsScreenData(0), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.breakdown.coffee).toBeTruthy());
  expect(result.current.budgeted).toBeUndefined(); // overlay absent, not crashing
  expect(result.current.isError).toBe(false);      // budgets outage never surfaces as a screen error
  expect(result.current.earned).toBe(0);           // actuals still flow (BREAKDOWN has no __earned__)
});
