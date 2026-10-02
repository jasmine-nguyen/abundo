// WHIT-686 slice 2 QA — the Transactions list over the pretend server, the paths the moved suites
// don't reach: the Uncategorized tab's own error / Retry / pull wiring, a pull after Load More
// snapping back to the newest page, and the pull spinner on the "more deeper in history" state.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), openMultiPicker: jest.fn(), showToast: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, settle } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { uncategorizedFeedKey } from '../queryKeys';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';
const REFRESH = '/accounts/balances/refresh';

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null };
const row = (id: string, amount: number, category: string | null = 'groceries') => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01', description: 'WOOLWORTHS',
  merchant_name: 'Woolworths', amount, account_id: 'a1', account_name: 'ANZ', category,
  status: 'posted', type: 'purchase', counts_to_budget: true,
});

// Exact path match, so the uncategorized feed (/transactions/uncategorized/feed) never counts as
// the All feed and a cursor read is told apart from a first-page read.
const gets = (path: string) => server.sentUnder('GET', path).filter((request) => request.path === path).length;
const cursorGets = (path: string) => server.sentUnder('GET', `${path}?cursor=`).length;
const refreshControl = () => screen.UNSAFE_getByType(RefreshControl);
const pull = () => act(async () => { refreshControl().props.onRefresh(); });

beforeEach(() => {
  resetAuth();
  server.seed('/categories', [CAT]);
  server.seed(FEED, { transactions: [row('t1', -42)], nextCursor: null });
});

// [A1] (P0)
it('[A1] Uncategorized tab, empty + feed error: inline Retry re-reads the UNCATEGORIZED feed, not the All feed', async () => {
  server.fail(UNCATEGORIZED_FEED, 500);
  server.seed(COUNT, { count: 3 });
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByTestId('transactions-error', {}, { timeout: 10000 })).toBeTruthy();
  expect(screen.queryByText('-$42.00')).toBeNull(); // the All tab's row never leaks onto this tab
  const uncategorizedBefore = gets(UNCATEGORIZED_FEED);
  const allBefore = gets(FEED);
  fireEvent.press(screen.getByTestId('transactions-retry'));
  await waitFor(() => expect(gets(UNCATEGORIZED_FEED)).toBeGreaterThan(uncategorizedBefore));
  expect(gets(FEED)).toBe(allBefore);
});

// [A2] (P1)
it('[A2] a pull on the Uncategorized tab re-reads the uncategorized feed and leaves the All feed alone', async () => {
  server.seed(UNCATEGORIZED_FEED, { transactions: [row('u1', -9, null)], nextCursor: null });
  server.seed(COUNT, { count: 1 });
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByText('-$9.00')).toBeTruthy();
  await settle();
  const before = { uncategorized: gets(UNCATEGORIZED_FEED), all: gets(FEED) };
  await pull();
  await waitFor(() => expect(gets(UNCATEGORIZED_FEED)).toBe(before.uncategorized + 1));
  expect(gets(FEED)).toBe(before.all);
  expect(server.sent('POST', REFRESH)).toHaveLength(1);
  await waitFor(() => expect(refreshControl().props.refreshing).toBe(false));
});

// [A3] (P1)
it('[A3] a pull after Load More snaps the list back to the newest page (older rows go, Load More returns)', async () => {
  server.seed(FEED, { transactions: [row('t1', -42)], nextCursor: 'c1' });
  await renderWithQueries(<Transactions />);
  server.once('GET', FEED, { body: { transactions: [row('t2', -7)], nextCursor: null } });
  fireEvent.press(screen.getByTestId('transactions-load-more'));
  expect(await screen.findByText('-$7.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-load-more')).toBeNull();

  await pull();
  await waitFor(() => expect(screen.queryByText('-$7.00')).toBeNull());
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(await screen.findByTestId('transactions-load-more')).toBeTruthy();
  expect(cursorGets(FEED)).toBe(1); // the pull re-read page 1 only, not the older page
  await waitFor(() => expect(refreshControl().props.refreshing).toBe(false));
});

// [A5] (P1)
it('[A5] the pull spinner shows on the Uncategorized "more deeper in history" state (no rows loaded)', async () => {
  server.seed(UNCATEGORIZED_FEED, { transactions: [], nextCursor: 'c1' });
  server.seed(COUNT, { count: 4 });
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByTestId('transactions-uncategorized-more')).toBeTruthy();
  await settle();
  const held = server.hold(REFRESH);
  await pull();
  expect(refreshControl().props.refreshing).toBe(true);
  held.release();
  await waitFor(() => expect(refreshControl().props.refreshing).toBe(false));
});

// [A6] (P1)
it('[A6] Uncategorized tab: a failed background refresh over loaded rows keeps the rows and shows no error', async () => {
  server.seed(UNCATEGORIZED_FEED, { transactions: [row('u1', -9, null)], nextCursor: null });
  server.seed(COUNT, { count: 1 });
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByText('-$9.00')).toBeTruthy();
  await settle();
  server.fail(UNCATEGORIZED_FEED, 500);
  await refreshInAct(() => queryClient.refetchQueries({ queryKey: uncategorizedFeedKey }));
  await waitFor(() => expect(queryClient.getQueryState(uncategorizedFeedKey)?.status).toBe('error'), { timeout: 10000 });
  expect(screen.getByText('-$9.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});
