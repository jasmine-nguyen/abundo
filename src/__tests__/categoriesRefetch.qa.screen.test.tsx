// WHIT-669 QA — the stable useCategories reload actions must still DO their job: a stale read
// reloads, and a reload after a failed load brings the categories back.
// Real ../queries over the fake server; ../auth mocked.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));

import { useCategories } from '../queries';

const server = installFakeServer();

const COFFEE = { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 };

function makeClient(staleTime: number) {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
}
function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe('useCategories reload actions still act (WHIT-669 QA)', () => {
  // [A1]
  it('a refetchStale captured before the load reloads once the loaded data is stale', async () => {
    server.seed('/categories', [COFFEE]);
    const { result } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient(0)) });
    const early = result.current.refetchStale;
    await waitFor(() => expect(result.current.categories).toHaveLength(1));
    expect(server.sent('GET', '/categories')).toHaveLength(1);
    await act(async () => { early(); });
    await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(2));
  });

  // [A2]
  it('a refetch captured before a failed load brings the categories back', async () => {
    server.seed('/categories', [COFFEE]);
    server.once('GET', '/categories', { status: 503 });
    const { result } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient(60_000)) });
    const early = result.current.refetch;
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.categories).toHaveLength(0);
    await act(async () => { early(); });
    await waitFor(() => expect(result.current.categories).toHaveLength(1));
    expect(result.current.isError).toBe(false);
    expect(result.current.category('coffee')?.name).toBe('Cafes & Coffee');
  });
});
