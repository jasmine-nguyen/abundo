// WHIT-640 QA — what the moved hook suites could not see behind their api mocks: the real api.ts
// request and response steps under the count, merchants and category-drill hooks. Real ../api over
// the fake server, ../auth mocked; real QueryClient.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { useUncategorizedCount, useCategoryCycleTransactionsQuery } from '../queries';
import { uncategorizedCountKey } from '../queryKeys';

const server = installFakeServer();
const COUNT_PATH = '/transactions/uncategorized/count';

// [A5] A stringified "0" would read as a count and defeat the `=== 0` "All caught up" gate; api.ts
// must reject it so the hook stays undefined and screens fall back to the local count.
it('[A5] a malformed count envelope ({count:"0"}) leaves the hook undefined, never "0"', async () => {
  server.seed(COUNT_PATH, { count: '0' });
  const client = makeClient({ staleTime: 0 });
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(client) });
  await waitFor(() => expect(client.getQueryState(uncategorizedCountKey)?.status).toBe('error'));
  expect(result.current).toBeUndefined();
  expect(server.sent('GET', COUNT_PATH)).toHaveLength(1);
});

// [A9]
it('[A9] a past cycle sends ?cycle=n; a date range replaces the cycle entirely', async () => {
  const client = makeClient({ staleTime: 0 });
  const past = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 2, true), { wrapper: wrapper(client) });
  await waitFor(() => expect(past.result.current.isSuccess).toBe(true));
  const range = renderHook(
    () => useCategoryCycleTransactionsQuery('coffee', 2, true, { from: '2026-06-12', to: '2026-09-11' }),
    { wrapper: wrapper(client) },
  );
  await waitFor(() => expect(range.result.current.isSuccess).toBe(true));
  expect(server.sentUnder('GET', '/categories/coffee/transactions').map((request) => request.path)).toEqual([
    '/categories/coffee/transactions?cycle=2',
    '/categories/coffee/transactions?from=2026-06-12&to=2026-09-11',
  ]);
});
