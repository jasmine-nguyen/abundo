// WHIT-203 — the shared hooks the second-tier readers moved onto: useCategories (the
// taxonomy the pickers / category screens / rules label / tab badge read), usePayCycle
// (the Settings row + pay-cycle sheet), and useBudgetDetailScreenData (the budget-detail
// screen). ../api + ../auth mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
const mockFetchBudgets = jest.fn<() => Promise<unknown>>();
const mockFetchTransactions = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
  fetchBudgets: () => mockFetchBudgets(),
  fetchTransactions: () => mockFetchTransactions(),
}));

import { useCategories, usePayCycle, useBudgetDetailScreenData, useBudgetsScreenData } from '../queries';

const CATS = [{ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];

function makeClient(staleTime = 60_000) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue({ length: 30, last_pay_date: '2024-01-03' });
  mockFetchBudgets.mockReset().mockResolvedValue({ coffee: { target: 100, posted: 40, pending: 10 } });
  mockFetchTransactions.mockReset().mockResolvedValue([]);
});

it('useCategories maps the list + a null-tolerant lookup, and does not fetch before login', async () => {
  mockAuthStatus = 'anon';
  const anon = renderHook(() => useCategories(), { wrapper: wrapper(makeClient()) });
  expect(mockFetchCategories).not.toHaveBeenCalled();
  expect(anon.result.current.categories).toEqual([]);
  expect(anon.result.current.category('coffee')).toBeUndefined();

  mockAuthStatus = 'authed';
  const { result } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.categories).toHaveLength(1));
  expect(result.current.category('coffee')?.name).toBe('Coffee');
  expect(result.current.category(null)).toBeUndefined();
});

it('usePayCycle derives the cycle name from the fetched length', async () => {
  const { result } = renderHook(() => usePayCycle(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.cycleLen).toBe(30));
  expect(result.current.cycleName()).toBe('Monthly');
});

it('useBudgetDetailScreenData assembles transactions + budgets + categories + the cycle window', async () => {
  const { result } = renderHook(() => useBudgetDetailScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.cycleLen).toBe(30);
  expect(result.current.category('coffee')?.name).toBe('Coffee');
  expect(result.current.budgets).toEqual([{ id: 'coffee', budget: 100, posted: 40, pending: 10 }]);
  expect(result.current.isError).toBe(false);
});

// WHIT-204: the composite routes its status through the shared useCombineScreenQueries helper.
// These two lock that the TRANSACTIONS query is actually in that array (the array-transcription
// risk the plan-critic flagged for the 7th composite) — a transactions failure must surface as
// isError, and refetchStale must re-fire the transactions read.
it('useBudgetDetailScreenData surfaces a transactions read failure as isError (not a stranded spinner)', async () => {
  mockFetchTransactions.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useBudgetDetailScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true)); // transactionsQuery IS in the OR
  expect(result.current.isLoading).toBe(false);                   // errored dependency → not an endless spinner
});

it('useBudgetDetailScreenData refetchStale re-fires every stale read exactly once (incl. transactions)', async () => {
  const { result } = renderHook(() => useBudgetDetailScreenData(), { wrapper: wrapper(makeClient(0)) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  await waitFor(() => expect(mockFetchTransactions).toHaveBeenCalledTimes(1));

  await act(async () => { result.current.refetchStale(); });
  // staleTime 0 → immediately stale → each read (transactions included) refires once.
  await waitFor(() => expect(mockFetchTransactions).toHaveBeenCalledTimes(2)); // transactionsQuery IS in refetchStale
  expect(mockFetchBudgets).toHaveBeenCalledTimes(2);
  expect(mockFetchCategories).toHaveBeenCalledTimes(2);
});

// WHIT-204 — DIRECT lock on the shared helper's load-bearing semantic: isLoading ORs the
// queries' `.isLoading`, NOT `.isPending`. When payCycle FAILS, the budgets query stays
// disabled (gated on payCycle success); a disabled v5 query reports isPending:true but
// isLoading:false. So the composite's isLoading must be FALSE — an errored dependency shows
// the error, not an endless spinner. The screen-level budgetsQueryGaps test can't catch a
// regression here (its error state masks the spinner via precedence), so lock it directly on
// the composite: reverting the helper to `.isPending` flips this to true and fails.
it('useBudgetsScreenData: a payCycle failure does NOT strand isLoading (helper ORs .isLoading, not .isPending)', async () => {
  mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
  const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.isLoading).toBe(false);
});

// Same lock for the budget-detail composite (it also gates budgets on payCycle.isSuccess) —
// so a dropped payCycle from ITS status array can't ship green either.
it('useBudgetDetailScreenData: a payCycle failure surfaces as isError, not a stranded spinner', async () => {
  mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
  const { result } = renderHook(() => useBudgetDetailScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true)); // payCycleQuery IS in the OR
  expect(result.current.isLoading).toBe(false);
});
