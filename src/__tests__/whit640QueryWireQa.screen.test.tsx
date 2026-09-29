// WHIT-640 QA — what the moved hook suites could not see behind their api mocks: the real api.ts
// request and response steps under the count, merchants and category-drill hooks. Real ../api over
// the fake server, ../auth mocked; real QueryClient.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {}, getAuthToken: async () => 'test-id-token' }));

import {
  useUncategorizedCount,
  uncategorizedCountKey,
  useUncategorizedMerchants,
  useCategoryCycleTransactionsQuery,
} from '../queries';

const server = installFakeServer();
const COUNT_PATH = '/transactions/uncategorized/count';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

// [A5] A stringified "0" would read as a count and defeat the `=== 0` "All caught up" gate; api.ts
// must reject it so the hook stays undefined and screens fall back to the local count.
it('[A5] a malformed count envelope ({count:"0"}) leaves the hook undefined, never "0"', async () => {
  server.seed(COUNT_PATH, { count: '0' });
  const client = makeClient();
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(client) });
  await waitFor(() => expect(client.getQueryState(uncategorizedCountKey)?.status).toBe('error'));
  expect(result.current).toBeUndefined();
  expect(server.sent('GET', COUNT_PATH)).toHaveLength(1);
});

// [A6]
it('[A6] a 500 on the count leaves the hook undefined, not 0', async () => {
  server.fail(COUNT_PATH, 500);
  const client = makeClient();
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(client) });
  await waitFor(() => expect(client.getQueryState(uncategorizedCountKey)?.status).toBe('error'));
  expect(result.current).toBeUndefined();
});

// [A7]
it('[A7] a 500 on the shop list surfaces isError with no merchants', async () => {
  server.fail('/transactions/uncategorized/merchants', 500);
  const { result } = renderHook(() => useUncategorizedMerchants(true), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.merchants).toBeUndefined();
});

// [A8] An id with a space and a slash must travel as ONE encoded path part.
it('[A8] the category id is URL-encoded into a single path segment', async () => {
  const encoded = '/categories/eating%20out%2Fcafe/transactions';
  server.seed(encoded, [{ transaction_id: 't1' }]);
  const { result } = renderHook(() => useCategoryCycleTransactionsQuery('eating out/cafe', 0, true), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.data).toEqual([{ transaction_id: 't1' }]));
  expect(server.requests().map((request) => request.path)).toEqual([encoded]);
});

// [A9]
it('[A9] a past cycle sends ?cycle=n; a date range replaces the cycle entirely', async () => {
  const client = makeClient();
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

// [A10] An empty id never fires a request (it would hit /categories//transactions).
it('[A10] an empty category id sends nothing', async () => {
  const { result } = renderHook(() => useCategoryCycleTransactionsQuery('', 0, true), { wrapper: wrapper(makeClient()) });
  await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
  expect(result.current.status).toBe('pending');
  expect(server.requests()).toEqual([]);
});
