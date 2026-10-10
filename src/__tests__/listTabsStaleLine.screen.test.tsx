// WHIT-713 (slice 2) — Accounts and Transactions: a failed refresh over a list that's already
// showing says so with the quiet "Couldn't refresh · showing <time>" line, and keeps the list.
// Real screens + ../queries + ../api over the fake server, inside the real AppProvider. The clock
// is pinned to 9:40am Melbourne for the first load, then moved on before the failed pull, so the
// line must name the ORIGINAL load time (not the pull's time).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { pullAndSettle } from './support/pull';
import { txn } from './factory';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, settle } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Accounts from '../../app/(tabs)/accounts';
import Transactions from '../../app/(tabs)/transactions';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
beforeEach(() => {
  resetListTabs(server);
});

afterEach(() => {
  jest.useRealTimers();
});

it('Accounts: a pull that loses the connection keeps the cards and says "You look offline · showing 9:40am", cleared by a good pull', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Accounts />);
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('accounts-stale')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:00:00+10:00'));
  server.once('GET', FEED, 'dropped');
  await pullAndSettle();

  await waitFor(() => expect(screen.getByTestId('accounts-stale')).toHaveTextContent('You look offline · showing 9:40am'));
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('accounts-error')).toBeNull();

  await pullAndSettle();
  await waitFor(() => expect(screen.queryByTestId('accounts-stale')).toBeNull());
  expect(screen.getByText('ANZ')).toBeTruthy();
});

it('Transactions: a failed pull after Load More keeps the rows and shows the original load time; the line hides during a search', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: 'c1' });
  await renderWithApp(<Transactions />);
  expect(await screen.findByText('-$42.00')).toBeTruthy();

  server.once('GET', FEED, { body: { transactions: [txn({ transaction_id: 't2', amount: -7, account_name: 'ANZ' })], nextCursor: null } });
  fireEvent.press(screen.getByTestId('transactions-load-more'));
  expect(await screen.findByText('-$7.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-stale')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:00:00+10:00'));
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();

  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();

  fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), 'wool');
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
});

// WHIT-844: Transactions always says when its list last loaded, quietly, under the search box.
// A failed refresh swaps it for the "Couldn't refresh" line; the next good refresh brings it back
// with the new load time.
it('Transactions: always shows "Updated <time>" after a good load, swapped for the stale line while a refresh fails (WHIT-844)', async () => {
  server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
  await renderWithApp(<Transactions />);
  expect(await screen.findByText('-$42.00')).toBeTruthy();
  expect(screen.getByTestId('transactions-updated')).toHaveTextContent('Updated 9:40am');
  expect(screen.queryByTestId('transactions-stale')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:00:00+10:00'));
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
  expect(screen.queryByTestId('transactions-updated')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:15:00+10:00'));
  await pullAndSettle();
  await waitFor(() => expect(screen.getByTestId('transactions-updated')).toHaveTextContent('Updated 10:15am'));
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
});

// WHIT-713 QA — a focus refetch with no pull, a categories-only failure, a balances-only failure,
// a failed pull after a failed Load More, the Uncategorized tab, and a cached-but-empty list.
describe('stale line edges', () => {
  const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';

  beforeEach(() => {
    server.seed(UNCATEGORIZED_FEED, { transactions: [], nextCursor: null });
  });

  // [A3] a focus refetch (no pull) that fails over cached cards still shows the line.
  it('Accounts: a failed background refetch on return to the tab shows the line with no pull', async () => {
    server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
    const first = await renderWithApp(<Accounts />);
    first.unmount();
    jest.setSystemTime(new Date('2026-09-18T10:00:00+10:00')); // past the 45s staleTime
    server.fail(FEED, 503);
    await renderWithApp(<Accounts />);
    await waitFor(() => expect(screen.getByTestId('accounts-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
    expect(screen.getByText('ANZ')).toBeTruthy();
  });

  // [A4] the list is the feed plus categories: a categories-only failure is a list refresh failure too.
  it('Transactions: a pull where only categories fail still shows the line', async () => {
    server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
    await renderWithApp(<Transactions />);
    server.once('GET', '/categories', { status: 500 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent(/^Couldn't refresh · showing /));
  });

  // [A5] balances are out: a failed live-balance call alone never claims the list is stale.
  it('Accounts: a pull where only the live balances fail shows no stale line', async () => {
    server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
    await renderWithApp(<Accounts />);
    server.fail('/accounts/balances/refresh', 503);
    server.fail('/accounts/balances', 503);
    await pullAndSettle();
    await settle();
    expect(screen.queryByTestId('accounts-stale')).toBeNull();
  });

  // [A6] a failed Load More must not hide a LATER failed pull (the Load More direction resets).
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

  // [A7] the line follows the ACTIVE feed: the Uncategorized tab's own feed loaded fine.
  it('Transactions: after a failed pull on All, switching to Uncategorized hides the line', async () => {
    server.seed(FEED, { transactions: [LIST_ROW], nextCursor: null });
    await renderWithApp(<Transactions />);
    server.once('GET', FEED, { status: 503 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('transactions-stale')).toBeTruthy());
    fireEvent.press(screen.getByText('Uncategorised'));
    await settle();
    expect(screen.queryByTestId('transactions-stale')).toBeNull();
  });

  // [A9] a cached EMPTY list that fails to refresh shows the full error card; the quiet line must
  // not stack on top of it saying the same thing twice.
  it('Accounts: a cached empty list that fails to refresh shows the error card only, not the stale line too', async () => {
    server.seed(FEED, { transactions: [], nextCursor: null });
    await renderWithApp(<Accounts />);
    server.once('GET', FEED, { status: 503 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('accounts-error')).toBeTruthy());
    expect(screen.queryByTestId('accounts-stale')).toBeNull();
  });
});
