// WHIT-203 — the shared hooks the second-tier readers moved onto: useCategories (the
// taxonomy the pickers / category screens / rules label / tab badge read), usePayCycle
// (the Settings row + pay-cycle sheet), and useBudgetDetailScreenData (the budget-detail
// screen). ../api + ../auth mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
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

import { useCategories, usePayCycle, useBudgetDetailScreenData } from '../queries';

const CATS = [{ id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
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
