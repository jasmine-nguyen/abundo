// WHIT-669 — useCategories' refetch / refetchStale must be STABLE across redraws (so a future
// screen's focus effect can't loop on a lasting failure) and still read the LATEST query state.
// Real ../queries over the fake server; ../auth mocked.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { makeClient, wrapper, pause } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));

import { useCategories } from '../queries';
import { COFFEE } from './support/categories';

const server = installFakeServer();
const CATEGORIES = [{ ...COFFEE, recent: 0 }];

describe('useCategories reload actions', () => {
  it('refetch and refetchStale keep the same identity across a rerender, a load and an error', async () => {
    server.seed('/categories', CATEGORIES);
    const { result, rerender } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient()) });
    const first = { refetch: result.current.refetch, refetchStale: result.current.refetchStale };

    rerender({});
    expect(result.current.refetch).toBe(first.refetch);
    expect(result.current.refetchStale).toBe(first.refetchStale);

    await waitFor(() => expect(result.current.categories).toHaveLength(1));
    expect(result.current.refetch).toBe(first.refetch);
    expect(result.current.refetchStale).toBe(first.refetchStale);

    server.fail('/categories', 503);
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.refetch).toBe(first.refetch);
    expect(result.current.refetchStale).toBe(first.refetchStale);
  });

  it('a refetchStale captured before the load skips the reload once the categories are fresh', async () => {
    server.seed('/categories', CATEGORIES);
    const { result } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient({ staleTime: Infinity })) });
    const early = result.current.refetchStale; // captured while the read was still pending (stale)
    await waitFor(() => expect(result.current.categories).toHaveLength(1));
    expect(server.sent('GET', '/categories')).toHaveLength(1);
    await act(async () => { early(); });
    await pause(20);
    expect(server.sent('GET', '/categories')).toHaveLength(1);
  });
});
