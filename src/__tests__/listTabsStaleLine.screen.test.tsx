// WHIT-713 (slice 2) — Accounts and Transactions: a failed refresh over a list that's already
// showing says so with the quiet "Couldn't refresh · showing <time>" line, and keeps the list.
// Real screens + ../queries + ../api over the fake server, inside the real AppProvider. The clock
// is pinned to 9:40am Melbourne for the first load, then moved on before the failed pull, so the
// line must name the ORIGINAL load time (not the pull's time).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { pinToday } from './support/clock';
import { pullAndSettle } from './support/pull';
import { txn } from './factory';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp, resetAppProbe } from './support/renderWithApp';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Accounts from '../../app/(tabs)/accounts';
import Transactions from '../../app/(tabs)/transactions';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const ROW = txn({ amount: -42, account_name: 'ANZ' });

beforeEach(() => {
  pinToday(new Date('2026-09-18T09:40:00+10:00'));
  resetAuth();
  resetAppProbe();
  resetRouter();
  server.seed('/categories', [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null }]);
});

afterEach(() => {
  jest.useRealTimers();
});

it('Accounts: a pull that loses the connection keeps the cards and says "You look offline · showing 9:40am", cleared by a good pull', async () => {
  server.seed(FEED, { transactions: [ROW], nextCursor: null });
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
  server.seed(FEED, { transactions: [ROW], nextCursor: 'c1' });
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
