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
import { renderHook, waitFor } from '@testing-library/react-native';
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
});

it('a payCycle failure surfaces as isError and does NOT strand isLoading (payCycle IS in the Insights array)', async () => {
  mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.isError).toBe(true)); // payCycleQuery IS in the OR
  expect(result.current.isLoading).toBe(false);                   // errored dependency → inline error, not a forever spinner
  // breakdown stays disabled behind payCycleQuery.isSuccess, so it never fetched the doomed window.
  expect(mockFetchBreakdown).not.toHaveBeenCalled();
});
