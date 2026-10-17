// WHIT-713 (slice 2) — Accounts and Transactions: a failed refresh over a list that's already
// showing says so with the quiet "Couldn't refresh · showing <time>" line, and keeps the list.
// Real screens + ../queries + ../api over the fake server, inside the real AppProvider. The clock
// is pinned to 9:40am Melbourne for the first load, then moved on before the failed pull, so the
// line must name the ORIGINAL load time (not the pull's time).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor, within } from '@testing-library/react-native';
import { pullAndSettle } from './support/pull';
import { txn } from './factory';
import { installFakeServer, seedFeedPage } from './support/fakeServer';
import { useTestQueryClient, settle } from './support/renderWithQueries';
import { renderWithApp, currentSheet } from './support/renderWithApp';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';
import { styleOf } from './support/layout';
import { C } from '../theme';

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
  seedFeedPage(server, FEED, [LIST_ROW]);
  await renderWithApp(<Accounts />);
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('accounts-stale')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:00:00+10:00'));
  server.once('GET', FEED, 'dropped');
  await pullAndSettle();

  await waitFor(() => expect(within(screen.getByTestId('screen-header')).getByTestId('accounts-stale')).toHaveTextContent('You look offline · showing 9:40am'));
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('accounts-error')).toBeNull();

  await pullAndSettle();
  await waitFor(() => expect(screen.queryByTestId('accounts-stale')).toBeNull());
  expect(screen.getByText('ANZ')).toBeTruthy();
});

it('Transactions: a failed pull after Load More keeps the rows and shows the original load time; the line hides during a search', async () => {
  seedFeedPage(server, FEED, [LIST_ROW], 'c1');
  await renderWithApp(<Transactions />);
  expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();

  server.once('GET', FEED, { body: { transactions: [txn({ transaction_id: 't2', amount: -7, account_name: 'ANZ' })], nextCursor: null } });
  fireEvent.press(screen.getByTestId('transactions-load-more'));
  expect(await screen.findByText('−\u2060$7.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-stale')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:00:00+10:00'));
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();

  await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
  expect(screen.getByText('−\u2060$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();

  fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), 'wool');
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
});

// WHIT-844: Transactions always says when its list last loaded, quietly, under the search box.
// A failed refresh swaps it for the "Couldn't refresh" line; the next good refresh brings it back
// with the new load time.
it('Transactions: always shows "Updated <time>" after a good load, swapped for the stale line while a refresh fails (WHIT-844)', async () => {
  seedFeedPage(server, FEED, [LIST_ROW]);
  await renderWithApp(<Transactions />);
  expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();
  // WHIT-863: the line lives in the screen header, under the title.
  const header = () => within(screen.getByTestId('screen-header'));
  expect(header().getByTestId('transactions-updated')).toHaveTextContent('Updated 9:40am');
  expect(screen.queryByTestId('transactions-stale')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:00:00+10:00'));
  server.once('GET', FEED, { status: 503 });
  await pullAndSettle();
  await waitFor(() => expect(header().getByTestId('transactions-stale')).toHaveTextContent("Couldn't refresh · showing 9:40am"));
  expect(screen.queryByTestId('transactions-updated')).toBeNull();

  jest.setSystemTime(new Date('2026-09-18T10:15:00+10:00'));
  await pullAndSettle();
  await waitFor(() => expect(header().getByTestId('transactions-updated')).toHaveTextContent('Updated 10:15am'));
  expect(screen.queryByTestId('transactions-stale')).toBeNull();
});

// WHIT-858 / ABU-82: the line sums up the bank sync in one short part: "● 1 account behind ›" (amber
// dot; accounts over a day old) or "Banks synced ›". Tapping it opens the bankSync sheet with every
// account in name order. It reads from the all-accounts feed, so Uncategorised shows it too.
it('Transactions: shows "● 1 account behind ›" on both tabs, and tapping it opens the bank sync sheet (ABU-82)', async () => {
  const upRow = txn({ transaction_id: 'u1', amount: -42, account_id: 'up-spending', account_name: 'Up Spending' });
  seedFeedPage(server, '/transactions/uncategorized/feed', [{ ...upRow, category: '' }]);
  // [A4] Westpac has more loaded rows than Up, so a busiest-first order would put it first.
  const westpacRows = ['w1', 'w2'].map((transaction_id) => txn({ transaction_id, amount: -3, account_id: 'westpac-altitude-qantas-black', account_name: 'Westpac Altitude Qantas Black' }));
  const westpacAt = new Date('2026-09-16T07:55:00+10:00').getTime();
  const upAt = new Date('2026-09-18T08:10:00+10:00').getTime();
  seedFeedPage(server, FEED, [upRow, ...westpacRows], null, {
    'westpac-altitude-qantas-black': westpacAt,
    'up-spending': upAt,
  });
  await renderWithApp(<Transactions />);
  expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();

  // [A3] WHIT-863: the line lives in the screen header.
  const header = () => within(screen.getByTestId('screen-header'));
  const expectCompactLine = async () => {
    await waitFor(() => expect(header().getByTestId('transactions-updated')).toHaveTextContent('Updated 9:40am · ● 1 account behind ›'));
    expect(styleOf(header().getByTestId('transactions-bank-sync-dot')).color).toBe(C.warn);
  };

  await expectCompactLine();
  fireEvent.press(screen.getByText('Uncategorised'));
  await settle();
  await expectCompactLine();

  fireEvent.press(header().getByTestId('transactions-bank-sync'));
  expect(currentSheet()).toEqual({
    mode: 'bankSync',
    accounts: [
      { id: 'up-spending', name: 'Up Spending', at: upAt },
      { id: 'westpac-altitude-qantas-black', name: 'Westpac Altitude Qantas Black', at: westpacAt },
    ],
  });
});

// WHIT-713 QA — a focus refetch with no pull, a categories-only failure, a balances-only failure,
// a failed pull after a failed Load More, the Uncategorized tab, and a cached-but-empty list.
describe('stale line edges', () => {
  const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';

  beforeEach(() => {
    seedFeedPage(server, UNCATEGORIZED_FEED, []);
  });

  // [A3] a focus refetch (no pull) that fails over cached cards still shows the line.
  it('Accounts: a failed background refetch on return to the tab shows the line with no pull', async () => {
    seedFeedPage(server, FEED, [LIST_ROW]);
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
    seedFeedPage(server, FEED, [LIST_ROW]);
    await renderWithApp(<Transactions />);
    server.once('GET', '/categories', { status: 500 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('transactions-stale')).toHaveTextContent(/^Couldn't refresh · showing /));
  });

  // [A5] balances are out: a failed live-balance call alone never claims the list is stale.
  it('Accounts: a pull where only the live balances fail shows no stale line', async () => {
    seedFeedPage(server, FEED, [LIST_ROW]);
    await renderWithApp(<Accounts />);
    server.fail('/accounts/balances/refresh', 503);
    server.fail('/accounts/balances', 503);
    await pullAndSettle();
    await settle();
    expect(screen.queryByTestId('accounts-stale')).toBeNull();
  });

  // [A6] a failed Load More must not hide a LATER failed pull (the Load More direction resets).
  it('Transactions: a failed Load More, then a failed pull → the line shows', async () => {
    seedFeedPage(server, FEED, [LIST_ROW], 'c1');
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
    seedFeedPage(server, FEED, [LIST_ROW]);
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
    seedFeedPage(server, FEED, []);
    await renderWithApp(<Accounts />);
    server.once('GET', FEED, { status: 503 });
    await pullAndSettle();
    await waitFor(() => expect(screen.getByTestId('accounts-error')).toBeTruthy());
    expect(screen.queryByTestId('accounts-stale')).toBeNull();
  });
});
