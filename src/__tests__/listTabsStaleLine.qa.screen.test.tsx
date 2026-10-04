// WHIT-713 (slice 2) QA — adversarial cases for the quiet "Couldn't refresh · showing <time>" line on
// Accounts and Transactions, beyond the proof tests in listTabsStaleLine.screen.test.tsx: the other
// wording per tab, a focus refetch with no pull, a categories-only failure, a balances-only failure,
// a failed pull after a failed Load More, the Uncategorized tab, a cached-but-empty list, and a
// cleared search. Real screens + queries + api over the fake server in the real AppProvider.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { pullAndSettle } from './support/pull';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, settle } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Accounts from '../../app/(tabs)/accounts';
import Transactions from '../../app/(tabs)/transactions';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const CATEGORIES = '/categories';
const LATER = new Date('2026-09-18T10:00:00+10:00');

beforeEach(() => {
  resetListTabs(server);
  server.seed(UNCATEGORIZED_FEED, { transactions: [], nextCursor: null });
});

afterEach(() => {
  jest.useRealTimers();
});

// [A1] (P0)
it('Accounts: a pull answered 5xx says "Couldn\'t refresh · showing 9:40am" and keeps the cards', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Accounts />);
  jest.setSystemTime(LATER);
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('accounts-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
  expect(screen.getByText('ANZ')).toBeTruthy();
});

// [A2] (P0)
it('Transactions: a pull that loses the connection says "You look offline", and a good pull clears it', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Transactions />);
  jest.setSystemTime(LATER);
  server.once('GET', FEED, 'dropped');
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent('You look offline · showing 9:40am'));
  await pullAndSettle();
  await waitFor(() => expect(screen.queryByTestId('transactions-stale')).toBeNull());
});

// [A3] (P0) — a focus refetch (no pull) that fails over cached cards still shows the line.
it('Accounts: a failed background refetch on return to the tab shows the line with no pull', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  const first = await renderWithApp(<Accounts />);
  first.unmount();
  jest.setSystemTime(LATER); // past the 45s staleTime
  server.fail(FEED, 503);
  await renderWithApp(<Accounts />);
  await waitFor(() => expect(screen.getByTestId('accounts-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
  expect(screen.getByText('ANZ')).toBeTruthy();
});

// [A4] (P1) — the list is the feed plus categories: a categories-only failure is a list refresh failure too.
it('Transactions: a pull where only categories fail still shows the line', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Transactions />);
  server.once('GET', CATEGORIES, { status: 500 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent(/^Couldn't refresh · showing /));
});

// [A5] (P1) — balances are out: a failed live-balance call alone never claims the list is stale.
it('Accounts: a pull where only the live balances fail shows no stale line', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Accounts />);
  server.fail('/accounts/balances/refresh', 503);
  server.fail('/accounts/balances', 503);
  await pullAndSettle();
  await settle();
  expect(screen.queryByTestId('accounts-stale')).toBeNull();
});

// [A6] (P0) — a failed Load More must not hide a LATER failed pull (the Load More direction resets).
it('Transactions: a failed Load More, then a failed pull → the line shows', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: 'c1' });
  await renderWithApp(<Transactions />);
  server.once('GET', FEED, { status: 503 });
  fireEvent.press(screen.getByTestId('transactions-load-more'));
  await settle();
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
});

// [A7] (P1) — the line follows the ACTIVE feed: the Uncategorized tab's own feed loaded fine.
it('Transactions: after a failed pull on All, switching to Uncategorized hides the line', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Transactions />);
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toBeTruthy());
  fireEvent.press(screen.getByText('Uncategorized'));
  await settle();
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
});

// [A8] (P1) — the line hides during a search and comes back once the search is cleared.
it('Transactions: clearing the search brings the line back', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Transactions />);
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toBeTruthy());
  fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), 'w');
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
  fireEvent.press(screen.getByLabelText('Clear search'));
  expect(screen.getByTestId('transactions-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am");
});

// [A9] (P1) — a cached EMPTY list that fails to refresh shows the full error card; the quiet line
// must not stack on top of it saying the same thing twice.
it('Accounts: a cached empty list that fails to refresh shows the error card only, not the stale line too', async () => {
  server.seed(FEED, { transactions: [], nextCursor: null });
  await renderWithApp(<Accounts />);
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('accounts-error')).toBeTruthy());
  expect(screen.queryByTestId('accounts-stale')).toBeNull();
});

// [A10] (P1) — same on Uncategorized, where an empty list ("all caught up") is the normal state.
it('Transactions: a cached empty list that fails to refresh shows the error card only, not the stale line too', async () => {
  server.seed(FEED, { transactions: [], nextCursor: null });
  await renderWithApp(<Transactions />);
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-error')).toBeTruthy());
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
});
