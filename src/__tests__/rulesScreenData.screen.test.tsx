// WHIT-195 — the Rules screen's composite on the REAL query layer: not fetched before
// login, fires on the auth flip, maps the server payload (value→pattern), self-heals a
// transient 5xx, surfaces a hard failure as isError (graceful, empty list), and focus-
// refetches only when stale (no request storm). ../api + ../auth mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => { mockAuthListeners.add(l); return () => mockAuthListeners.delete(l); },
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

const mockListEnrichments = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({ listEnrichments: () => mockListEnrichments() }));

import { useRulesScreenData } from '../queries';

const SERVER = [{ id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' }];

function makeClient(retry: boolean | number = false, staleTime = 60_000) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockListEnrichments.mockReset().mockResolvedValue(SERVER);
});

it('loads + maps the rules from the query (value→pattern, isNew:false)', async () => {
  const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.rules).toEqual([
    { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' },
  ]);
  expect(result.current.isError).toBe(false);
});

it('does not fetch before login, then fires on the auth flip to authed', async () => {
  mockAuthStatus = 'anon';
  const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient()) });
  expect(mockListEnrichments).not.toHaveBeenCalled();

  await act(async () => { setAuth('authed'); });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  expect(mockListEnrichments).toHaveBeenCalled();
});

it('a transient 5xx retries and self-heals', async () => {
  mockListEnrichments.mockReset().mockRejectedValueOnce(new Error('API error: 503')).mockResolvedValue(SERVER);
  const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient(2)) });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  expect(result.current.isError).toBe(false);
  expect(mockListEnrichments).toHaveBeenCalledTimes(2);
});

it('surfaces a sustained failure as isError with a graceful empty list', async () => {
  mockListEnrichments.mockReset().mockRejectedValue(new Error('API error: 500'));
  const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient(false)) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.isLoading).toBe(false);
  expect(result.current.rules).toEqual([]);
});

it('refetchStale is a no-op while fresh, but refetches when stale', async () => {
  // fresh (staleTime 60s): focus does not refire.
  const fresh = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient(false, 60_000)) });
  await waitFor(() => expect(fresh.result.current.isLoading).toBe(false));
  expect(mockListEnrichments).toHaveBeenCalledTimes(1);
  await act(async () => { fresh.result.current.refetchStale(); });
  expect(mockListEnrichments).toHaveBeenCalledTimes(1);

  // stale (staleTime 0): focus refetches once.
  mockListEnrichments.mockClear();
  const stale = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient(false, 0)) });
  await waitFor(() => expect(stale.result.current.isLoading).toBe(false));
  const before = mockListEnrichments.mock.calls.length;
  await act(async () => { stale.result.current.refetchStale(); });
  await waitFor(() => expect(mockListEnrichments.mock.calls.length).toBe(before + 1));
});
