// WHIT-576 — QA gap tests for the Transactions-tab full-history search (screen half).
// transactionsSearchServer.screen.test.tsx locks the happy paths; these lock the transitions it
// doesn't: a stale server answer vs the live text [A1], clearing the box while the debounce still
// holds the old query [A2], a re-filed row dropping off the Uncategorized tab [A3], the pull spinner
// when only the search has rows [A4], and "No matches" never sharing the screen with Load More [A5].
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), openMultiPicker: jest.fn(), showToast: jest.fn(), setSheet: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries } from './support/renderWithQueries';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const SEARCH = '/transactions/search';
const row = (id: string, merchant: string, amount: number, date = '2026-07-01', cat: string | null = null) => ({
  transaction_id: id, date, authorized_date: date, description: merchant.toUpperCase(),
  merchant_name: merchant, amount, account_id: 'a1', account_name: 'ANZ', category: cat,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const COLES = row('coles', 'Coles', -12.5);
const STEVEN_DEEP = row('steven-old', 'Steven Nguyen', -77, '2024-02-03');

const seedSearch = (transactions: unknown[], truncated = false) => server.seed(SEARCH, { transactions, truncated });
const searches = () => server.sentUnder('GET', SEARCH).map((request) => request.path);

const type = (query: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), query);
const pauseTyping = () => act(async () => { jest.advanceTimersByTime(300); });
const refreshControl = () => screen.UNSAFE_getByType(RefreshControl);

// Under fake timers the first reads can still be settling when renderWithQueries returns.
async function draw() {
  await renderWithQueries(<Transactions />);
  await waitFor(() => expect(screen.queryByTestId('transactions-loading')).toBeNull());
}

beforeEach(() => {
  jest.useFakeTimers();
  resetAuth();
  server.seed('/categories', [GROCERIES_RECORD]);
  server.seed('/transactions/feed', { transactions: [COLES], nextCursor: 'c1' });
});
afterEach(() => { jest.useRealTimers(); });

it('[A1] the previous query\'s answer never produces "No matches" for newer live text', async () => {
  seedSearch([STEVEN_DEEP]);
  await draw();
  type('steven');
  await pauseTyping();
  expect(await screen.findByText('-$77.00')).toBeTruthy();

  type('stevenx'); // the screen still holds the "steven" answer until typing pauses
  expect(screen.queryByTestId('transactions-no-results')).toBeNull();
  expect(screen.getByTestId('transactions-searching')).toBeTruthy();
});

it('[A2] clearing the box restores the feed immediately, before the debounce settles', async () => {
  seedSearch([STEVEN_DEEP], true);
  await draw();
  type('steven');
  await pauseTyping();
  expect(await screen.findByTestId('transactions-search-truncated')).toBeTruthy();
  expect(screen.queryByTestId('transactions-load-more')).toBeNull();

  fireEvent.press(screen.getByLabelText('Clear search'));
  expect(screen.getByText('-$12.50')).toBeTruthy();
  expect(screen.queryByText('-$77.00')).toBeNull();
  expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
  expect(screen.queryByTestId('transactions-searching')).toBeNull();
  expect(screen.queryByTestId('transactions-search-truncated')).toBeNull();

  await pauseTyping();
  expect(searches()).toEqual(['/transactions/search?tab=all&q=steven']); // clearing asks nothing new
});

it('[A3] Uncategorized tab: a re-filed search result drops out, an unfiled one stays', async () => {
  const filed = row('steven-filed', 'Steven Nguyen', -33, '2024-01-01', 'groceries');
  server.seed('/transactions/uncategorized/feed', { transactions: [], nextCursor: 'c1' });
  server.seed('/transactions/uncategorized/count', { count: 2 });
  seedSearch([STEVEN_DEEP, filed]);
  await draw();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  type('steven');
  await pauseTyping();
  expect(await screen.findByText('-$77.00')).toBeTruthy();
  expect(searches()).toEqual(['/transactions/search?tab=uncategorized&q=steven']);
  expect(screen.queryByText('-$33.00')).toBeNull();
});

it('[A4] pull-to-refresh spins when only the search result has rows', async () => {
  server.seed('/transactions/feed', { transactions: [], nextCursor: null });
  seedSearch([STEVEN_DEEP]);
  await draw();
  type('steven');
  await pauseTyping();
  expect(await screen.findByText('-$77.00')).toBeTruthy();

  const held = server.hold('/accounts/balances/refresh'); // the pull stays in flight
  await act(async () => { refreshControl().props.onRefresh(); });
  await waitFor(() => expect(searches()).toHaveLength(2)); // the pull re-asks the search
  expect(refreshControl().props.refreshing).toBe(true);

  held.release();
  await waitFor(() => expect(refreshControl().props.refreshing).toBe(false));
});

// The card's original bug as an invariant. A "$"-only query (the first key of "$42") never asks the
// server, so it must behave like an empty box — not claim "No matches" above Load More.
it('[A5] "$" on the Uncategorized tab never claims "No matches" while Load More is showing', async () => {
  server.seed('/transactions/uncategorized/count', { count: 4 }); // unfiled charges exist deeper in history
  server.seed('/transactions/uncategorized/feed', {
    transactions: [row('filed', 'Coles', -12.5, '2026-07-01', 'groceries')], nextCursor: 'c1',
  });
  await draw();
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByTestId('transactions-uncategorized-more')).toBeTruthy();
  type('$');
  await pauseTyping();
  expect(searches()).toEqual([]);
  expect(screen.queryByTestId('transactions-no-results')).toBeNull();
  expect(screen.getByTestId('transactions-uncategorized-more')).toBeTruthy();
  expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
});
