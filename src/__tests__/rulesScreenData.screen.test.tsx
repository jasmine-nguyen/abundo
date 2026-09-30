// WHIT-195 — the Rules screen's composite on the REAL query layer: not fetched before
// login, fires on the auth flip, maps the server payload (value→pattern), self-heals a
// transient 5xx, surfaces a hard failure as isError (graceful, empty list), and focus-
// refetches only when stale (no request storm). Real ../api over the fake server, ../auth
// mocked; real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => { mockAuthListeners.add(l); return () => mockAuthListeners.delete(l); },
  getAuthToken: async () => 'test-id-token',
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

import { useRulesScreenData } from '../queries';

const server = installFakeServer();
const ruleRequests = () => server.sent('GET', '/rules');

const SERVER = [{ id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' }];

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  server.seed('/rules', SERVER);
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
  expect(ruleRequests()).toHaveLength(0);

  await act(async () => { setAuth('authed'); });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  expect(ruleRequests().length).toBeGreaterThan(0);
});

it('a transient 5xx retries and self-heals', async () => {
  server.once('GET', '/rules', { status: 503 });
  const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient({ retry: 2 })) });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  expect(result.current.isError).toBe(false);
  expect(ruleRequests()).toHaveLength(2);
});

it('surfaces a sustained failure as isError with a graceful empty list', async () => {
  server.fail('/rules', 500);
  const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.isLoading).toBe(false);
  expect(result.current.rules).toEqual([]);
});

it('refetchStale is a no-op while fresh, but refetches when stale', async () => {
  // fresh (staleTime 60s): focus does not refire.
  const fresh = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(fresh.result.current.isLoading).toBe(false));
  expect(ruleRequests()).toHaveLength(1);
  await act(async () => { fresh.result.current.refetchStale(); });
  expect(ruleRequests()).toHaveLength(1);

  // stale (staleTime 0): focus refetches once.
  const stale = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
  await waitFor(() => expect(stale.result.current.isLoading).toBe(false));
  const before = ruleRequests().length;
  await act(async () => { stale.result.current.refetchStale(); });
  await waitFor(() => expect(ruleRequests()).toHaveLength(before + 1));
});
