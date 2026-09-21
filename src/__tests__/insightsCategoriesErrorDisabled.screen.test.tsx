// WHIT-194 GAP (disabled-query guard) — authored by qa. categoriesError is
// `categoriesQuery.isError && data === undefined`. The `isError &&` conjunct matters: an
// auth-gated/DISABLED categories query is `isError:false, data:undefined` — it must NOT
// report categoriesError (else a naive `data === undefined && !isLoading` rewrite would
// strand the pre-auth / never-run screen on a phantom "Couldn't load"). AuthGate unmounts
// the tabs while unauthed, so this is a defensive unit-level lock on the conjunct.
// Fail-on-revert: dropping `isError &&` flips categoriesError to true here.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Unauthed → every query in the composite is disabled and never runs.
jest.mock('../auth', () => ({ getStatus: () => 'anon', subscribe: () => () => {} }));

const mockFetchBreakdown = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

import { useInsightsScreenData } from '../queries';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchBreakdown.mockReset().mockResolvedValue({});
  mockFetchCategories.mockReset().mockResolvedValue([]);
  mockFetchPayCycle.mockReset().mockResolvedValue({ length: 30, last_pay_date: '2026-07-01' });
});

it('a DISABLED categories query (unauthed, never ran) does NOT report categoriesError', async () => {
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  // Give any (doomed) effects a tick; nothing should fetch while unauthed.
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(result.current.categoriesError).toBe(false); // disabled ≠ first-load error
  expect(result.current.isError).toBe(false);
  expect(mockFetchCategories).not.toHaveBeenCalled();  // truly never ran (auth-gated)
});
