// WHIT-688 slice 2 — QA gaps over the fake server for the Accounts tab, account detail, Rules and
// Budgets screens: recovery after Retry (not just a re-request), a balances-only failure that must
// not blank the cards, the pull re-reading the list and showing the bank's fresh balance, and the
// "payday is today" edge of the Budgets "Started …" line. Real ../queries + ../api; only fetch is faked.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import { pinToday } from './support/clock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const mockShowToast = jest.fn();
const mockDeleteRule = jest.fn();
const mockSetSheet = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      showToast: mockShowToast, openPicker: jest.fn(), category: () => undefined,
      setSheet: mockSetSheet, deleteRule: mockDeleteRule,
    }),
  };
});

import Accounts from '../../app/(tabs)/accounts';
import AccountDetail from '../../app/account/[id]';
import Rules from '../../app/rules';
import Budgets from '../../app/(tabs)/budgets';

const server = installFakeServer();
useTestQueryClient();

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};
const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: 100, available_balance: 100, currency: 'AUD',
  as_of: '2026-07-08T09:32:02.405Z', account_type: 'checking', ...over,
});
const seedFeed = (transactions: unknown[]) => server.seed('/transactions/feed', { transactions, nextCursor: null });

beforeEach(() => {
  mockShowToast.mockClear();
  mockDeleteRule.mockClear();
  mockSetSheet.mockClear();
  resetAuth();
  resetRouter();
});

describe('Accounts tab', () => {
  // [A1] Retry after a cold failure, once the server recovers, draws the cards. Fail-on-revert:
  // wire onRetry to a no-op → the error stays and no card appears.
  it('[A1] Retry after a cold failure draws the cards once the server answers', async () => {
    seedFeed([ROW]);
    server.fail('/transactions/feed', 500);
    await renderWithQueries(<Accounts />);
    expect(screen.getByTestId('accounts-error')).toBeTruthy();

    server.seed('/accounts/balances', [bal({ amount: 250.5 })]);
    // Recover: the next feed read answers (a queued reply wins over the standing failure).
    server.once('GET', '/transactions/feed', { body: { transactions: [ROW], nextCursor: null } });
    const balanceReads = server.sent('GET', '/accounts/balances').length;
    fireEvent.press(screen.getByTestId('accounts-retry'));
    expect(await screen.findByText('ANZ')).toBeTruthy();
    expect(screen.queryByTestId('accounts-error')).toBeNull();
    // Retry also re-reads the STORED balances (cheap, no live bank call).
    await waitFor(() => expect(server.sent('GET', '/accounts/balances').length).toBe(balanceReads + 1));
    expect(server.sent('POST', '/accounts/balances/refresh')).toHaveLength(0);
    expect(await screen.findByText('$250.50')).toBeTruthy();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });

  // [A2] A balances outage alone must not blank the cards or show the list error: the card
  // shows the "—" placeholder. Fail-on-revert: fold the balances error into isError → error state.
  it('[A2] a failed balances read keeps the cards with the "—" placeholder, no error', async () => {
    seedFeed([ROW]);
    server.fail('/accounts/balances', 500);
    await renderWithQueries(<Accounts />);
    expect(screen.getByText('ANZ')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByTestId('accounts-error')).toBeNull();
  });

  // [A3] A pull on a loaded list re-reads the feed, asks the bank for fresh balances, and the card
  // shows the fresh number. Fail-on-revert: drop refreshLiveBalances' setQueryData → the old $100.00 stays.
  it('[A3] a pull re-reads the feed and shows the bank\'s fresh balance', async () => {
    seedFeed([ROW]);
    server.seed('/accounts/balances', [bal({ amount: 100 })]);
    await renderWithQueries(<Accounts />);
    expect(screen.getByText('$100.00')).toBeTruthy();
    const feedReads = server.sentUnder('GET', '/transactions/feed').length;

    server.seed('/accounts/balances', [bal({ amount: 321.09 })]); // what the live refresh returns
    act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
    expect(await screen.findByText('$321.09')).toBeTruthy();
    expect(server.sent('POST', '/accounts/balances/refresh')).toHaveLength(1);
    await waitFor(() => expect(server.sentUnder('GET', '/transactions/feed').length).toBe(feedReads + 1));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
    await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
  });

  // [A4] A failed live refresh keeps the last-good balance on the card and toasts.
  it('[A4] a failed live refresh keeps the last saved balance and toasts', async () => {
    seedFeed([ROW]);
    server.seed('/accounts/balances', [bal({ amount: 100 })]);
    await renderWithQueries(<Accounts />);
    server.once('POST', '/accounts/balances/refresh', { status: 500 });
    act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Could not refresh balances. Showing last saved.'));
    expect(screen.getByText('$100.00')).toBeTruthy();
    await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
  });
});

describe('Account detail', () => {
  // [A5] The real recent list holds every account's rows; the screen keeps only this account's.
  // Fail-on-revert: stop filtering by account_id → "2 transactions".
  it('[A5] shows only the opened account\'s rows from the shared recent list', async () => {
    setParams({ id: 'a1' });
    server.seed('/transactions', [ROW, { ...ROW, transaction_id: 't2', account_id: 'a2', account_name: 'Up' }]);
    await renderWithQueries(<AccountDetail />);
    expect(screen.getByText('1 transaction')).toBeTruthy();
  });

  // [A6] A balances outage keeps the list and shows no hero and no error.
  it('[A6] a failed balances read keeps the list, with no balance hero and no error', async () => {
    setParams({ id: 'a1' });
    server.seed('/transactions', [ROW]);
    server.fail('/accounts/balances', 500);
    await renderWithQueries(<AccountDetail />);
    expect(screen.getByText('1 transaction')).toBeTruthy();
    expect(screen.queryByTestId('account-balance')).toBeNull();
    expect(screen.queryByTestId('account-error')).toBeNull();
  });

  // [A7] Retry after a cold failure draws the list once the server answers.
  it('[A7] Retry after a cold failure draws the list once the server answers', async () => {
    setParams({ id: 'a1' });
    server.fail('/transactions', 500);
    await renderWithQueries(<AccountDetail />);
    expect(screen.getByTestId('account-error')).toBeTruthy();
    server.once('GET', '/transactions', { body: [ROW] });
    fireEvent.press(screen.getByTestId('account-retry'));
    expect(await screen.findByText('1 transaction')).toBeTruthy();
    expect(screen.queryByTestId('account-error')).toBeNull();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
});

describe('Rules', () => {
  // [A8] Retry after a failure draws the rules once the server answers (not just a re-request).
  it('[A8] Retry after a failure draws the rules once the server answers', async () => {
    server.seed('/categories', [{ id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle' }]);
    server.fail('/rules', 500);
    await renderWithQueries(<Rules />);
    expect(screen.getByText('Could not load your rules.')).toBeTruthy();
    server.once('GET', '/rules', { body: [{ id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' }] });
    fireEvent.press(screen.getByTestId('rules-retry'));
    expect(await screen.findByText('NETFLIX')).toBeTruthy();
    expect(screen.getByText('Subscriptions')).toBeTruthy();
    expect(screen.queryByText('Could not load your rules.')).toBeNull();
    expect(screen.getByText(/You have 1 active rule/)).toBeTruthy();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
});

describe('Budgets "Started …" line', () => {
  const today = new Date('2026-09-18T10:00:00+10:00');

  // [A9] Payday is today → the cycle has started today: "Started 18 Sep". Fail-on-revert: change
  // cycleStart's `pay > todayMs` to `>=` → no line → red.
  it('[A9] a last_pay_date of today shows "Started 18 Sep"', async () => {
    pinToday(today);
    try {
      server.seed('/paycycle', { length: 14, last_pay_date: '2026-09-18' });
      await renderWithQueries(<Budgets />);
      expect(screen.getByText('Started 18 Sep')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  // [A10] Payday tomorrow (the nearest future day) → no started cycle → no line.
  it('[A10] a last_pay_date of tomorrow shows no "Started …" line', async () => {
    pinToday(today);
    try {
      server.seed('/paycycle', { length: 14, last_pay_date: '2026-09-19' });
      await renderWithQueries(<Budgets />);
      expect(server.sent('GET', '/paycycle')).toHaveLength(1);
      expect(screen.queryByText(/^Started /)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
