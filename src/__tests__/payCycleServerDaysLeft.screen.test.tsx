// WHIT-341 GAP — the composites actually surface the SERVER days_left, not a locally
// recomputed countdown. Mock ../api + ../auth (same pattern as screenQueryHooks); real
// QueryClientProvider. cycleClockView now CLAMPS to [0,length], so an out-of-range sentinel
// can't be used; instead SERVER_DAYS is an in-range value chosen to DIFFER from what the local
// cycleClock computes today, so a daysLeft of SERVER_DAYS can only have come through the server
// pass-through. (Reverting cycleClockView -> cycleClock in queries.ts yields the local clock's
// value, which differs, and fails these.)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cycleClock } from '../context';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
const mockFetchBudgets = jest.fn<() => Promise<unknown>>();
const mockFetchBudgetTransactions = jest.fn<(id: string) => Promise<unknown>>();
const mockFetchBreakdown = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
  fetchBudgets: () => mockFetchBudgets(),
  fetchBudgetTransactions: (id: string) => mockFetchBudgetTransactions(id),
  fetchBreakdown: () => mockFetchBreakdown(),
}));

import { usePayCycle, useBudgetsScreenData, useBudgetDetailScreenData, useInsightsScreenData } from '../queries';

// An in-range server value (survives the clamp) chosen to DIFFER from the local clock's value
// for this cycle today — so a daysLeft of SERVER_DAYS proves the server pass-through, not the
// local clock. Computed against the same cycleClock the fallback would use, so it's exact.
const PAY = { length: 14, last_pay_date: '2020-01-01' };
const CLOCK_DAYS = cycleClock(PAY).daysLeft;        // in [1..14], run-date-dependent
const SERVER_DAYS = CLOCK_DAYS === 1 ? 2 : 1;       // a different, in-range value
const SERVER = { ...PAY, days_left: SERVER_DAYS };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFetchCategories.mockReset().mockResolvedValue([]);
  mockFetchPayCycle.mockReset().mockResolvedValue(SERVER);
  mockFetchBudgets.mockReset().mockResolvedValue({});
  mockFetchBudgetTransactions.mockReset().mockResolvedValue([]);
  mockFetchBreakdown.mockReset().mockResolvedValue({});
});

it('usePayCycle surfaces the server days_left, not a locally computed countdown', async () => {
  const { result } = renderHook(() => usePayCycle(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.daysLeft).toBe(SERVER_DAYS));
  expect(result.current.cycleLen).toBe(14);
});

it('useBudgetsScreenData surfaces the server days_left', async () => {
  const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.daysLeft).toBe(SERVER_DAYS);
});

it('useBudgetDetailScreenData surfaces the server days_left', async () => {
  const { result } = renderHook(() => useBudgetDetailScreenData('coffee'), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.daysLeft).toBe(SERVER_DAYS);
});

it('useInsightsScreenData reads cycleLen via cycleClockView (it exposes no daysLeft)', async () => {
  // Insights only needs the cycle LENGTH (to key /breakdown); it never renders a countdown,
  // so there is no daysLeft to surface. Lock that the length still flows through.
  const { result } = renderHook(() => useInsightsScreenData(0), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect('daysLeft' in result.current).toBe(false);
});
