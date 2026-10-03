// WHIT-669 QA — the stable useCategories reload actions must still DO their job: a stale read
// reloads, and a reload after a failed load brings the categories back.
// Real ../queries over the fake server; ../auth mocked.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { makeClient, wrapper } from './support/queryClient';
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

describe('useCategories reload actions still act (WHIT-669 QA)', () => {
  // [A1]
  it('a refetchStale captured before the load reloads once the loaded data is stale', async () => {
    server.seed('/categories', CATEGORIES);
    const { result } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
    const early = result.current.refetchStale;
    await waitFor(() => expect(result.current.categories).toHaveLength(1));
    expect(server.sent('GET', '/categories')).toHaveLength(1);
    await act(async () => { early(); });
    await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(2));
  });

  // [A2]
  it('a refetch captured before a failed load brings the categories back', async () => {
    server.seed('/categories', CATEGORIES);
    server.once('GET', '/categories', { status: 503 });
    const { result } = renderHook(() => useCategories(), { wrapper: wrapper(makeClient()) });
    const early = result.current.refetch;
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.categories).toHaveLength(0);
    await act(async () => { early(); });
    await waitFor(() => expect(result.current.categories).toHaveLength(1));
    expect(result.current.isError).toBe(false);
    expect(result.current.category('coffee')?.name).toBe('Cafes & Coffee');
  });
});
