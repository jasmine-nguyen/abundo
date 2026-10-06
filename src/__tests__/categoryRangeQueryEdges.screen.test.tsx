// Card 609 QA — the drill-in's date-range cache (the Ask Abundo deep link). A range must cache apart
// from the cycle view AND from other ranges for the same category, and must sit under the
// ['categoryTransactions'] prefix so a re-file (which invalidates that prefix) refreshes it.
// Real ../api over the fake server, ../auth mocked; real QueryClientProvider.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct } from './support/renderWithQueries';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { useCategoryCycleTransactionsQuery, categoryTransactionsKey } from '../queries';

const server = installFakeServer();

const COFFEE_PATH = '/categories/coffee/transactions';
const JUN_SEP = { from: '2026-06-12', to: '2026-09-11' };
const JUL_SEP = { from: '2026-07-01', to: '2026-09-11' };
const JUN_SEP_PATH = `${COFFEE_PATH}?from=2026-06-12&to=2026-09-11`;
const JUL_SEP_PATH = `${COFFEE_PATH}?from=2026-07-01&to=2026-09-11`;

it('[A25] a range caches apart from the cycle view and from another range', async () => {
  // Rows tagged by what was asked for, so a key collision shows up as the wrong rows. Replies go
  // out in request order; the log check below pins which request got which.
  server.once('GET', COFFEE_PATH, { body: [{ transaction_id: 'coffee-c0' }] });
  server.once('GET', COFFEE_PATH, { body: [{ transaction_id: 'coffee-2026-06-12' }] });
  server.once('GET', COFFEE_PATH, { body: [{ transaction_id: 'coffee-2026-07-01' }] });
  const client = makeClient();
  const cycle = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true), { wrapper: wrapper(client) });
  const jun = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, JUN_SEP), { wrapper: wrapper(client) });
  const jul = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, JUL_SEP), { wrapper: wrapper(client) });

  await waitFor(() => expect(jul.result.current.data).toBeDefined());
  await waitFor(() => expect(jun.result.current.data).toBeDefined());
  await waitFor(() => expect(cycle.result.current.data).toBeDefined());
  expect(server.sentUnder('GET', COFFEE_PATH).map((request) => request.path)).toEqual([COFFEE_PATH, JUN_SEP_PATH, JUL_SEP_PATH]);
  expect(cycle.result.current.data).toEqual([{ transaction_id: 'coffee-c0' }]);
  expect(jun.result.current.data).toEqual([{ transaction_id: 'coffee-2026-06-12' }]);
  expect(jul.result.current.data).toEqual([{ transaction_id: 'coffee-2026-07-01' }]);
});

it('[A26] invalidating the categoryTransactions prefix refetches a range query', async () => {
  server.seed(COFFEE_PATH, [{ transaction_id: 'coffee-2026-06-12' }]);
  const client = makeClient();
  const jun = renderHook(() => useCategoryCycleTransactionsQuery('coffee', 0, true, JUN_SEP), { wrapper: wrapper(client) });
  await waitFor(() => expect(jun.result.current.data).toBeDefined());
  expect(server.sentUnder('GET', COFFEE_PATH)).toHaveLength(1);

  await refreshInAct(() => client.invalidateQueries({ queryKey: categoryTransactionsKey }));
  await waitFor(() => expect(server.sentUnder('GET', COFFEE_PATH)).toHaveLength(2));
  expect(server.sentUnder('GET', COFFEE_PATH).map((request) => request.path)).toEqual([JUN_SEP_PATH, JUN_SEP_PATH]);
});
