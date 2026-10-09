// Card 609 QA — the drill-in's date-range query (the Ask Abundo deep link). The range must cache
// apart from the cycle view, and still sit under the categoryTransactions prefix so a categorise
// write's prefix invalidation refreshes it. Real ../api over the fake server, ../auth mocked; real QueryClient.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { QueryClient } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct } from './support/renderWithQueries';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { useCategoryCycleTransactionsQuery } from '../queries';
import { categoryTransactionsKey } from '../queryKeys';

const server = installFakeServer();

const COFFEE_PATH = '/categories/coffee/transactions';
const RANGE = { from: '2026-06-12', to: '2026-09-11' };
const RANGE_PATH = `${COFFEE_PATH}?from=2026-06-12&to=2026-09-11`;

// [A13]
it('a date range caches apart from the cycle view of the same category', async () => {
  // Replies go out in request order; the log check below pins which request got which.
  server.once('GET', COFFEE_PATH, { body: [{ transaction_id: 'coffee-c0' }] });
  server.once('GET', COFFEE_PATH, { body: [{ transaction_id: 'coffee-2026-06-12' }] });
  const client = makeClient();
  const cycle = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true), { wrapper: wrapper(client) });
  const range = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, RANGE), { wrapper: wrapper(client) });

  await waitFor(() => expect(cycle.result.current.data).toBeDefined());
  await waitFor(() => expect(range.result.current.data).toBeDefined());
  expect(server.sentUnder('GET', COFFEE_PATH).map((request) => request.path)).toEqual([COFFEE_PATH, RANGE_PATH]);
  expect(cycle.result.current.data).toEqual([{ transaction_id: 'coffee-c0' }]);
  expect(range.result.current.data).toEqual([{ transaction_id: 'coffee-2026-06-12' }]);
});

// [A14]
it('invalidating the categoryTransactions prefix refetches the date-range list', async () => {
  server.seed(COFFEE_PATH, [{ transaction_id: 'coffee-2026-06-12' }]);
  const client = makeClient();
  const range = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, RANGE), { wrapper: wrapper(client) });
  await waitFor(() => expect(range.result.current.data).toBeDefined());
  expect(server.sent('GET', RANGE_PATH)).toHaveLength(1);

  await refreshInAct(() => client.invalidateQueries({ queryKey: categoryTransactionsKey }));
  expect(server.sent('GET', RANGE_PATH)).toHaveLength(2);
});
