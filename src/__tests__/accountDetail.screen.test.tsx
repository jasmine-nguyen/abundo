// WHIT-212 — the account detail screen's balance hero: shows the signed live balance
// (green in credit / red owing), the credit-card "available" line ONLY when you owe yet
// have credit left, and hides it for a loan/spending account. Runs over the fake server: the
// real useRecentTransactionsScreenData reads the seeded GET /transactions + /accounts/balances.
// ../context is partially mocked (real selectors, stubbed useAppContext for TransactionRow);
// expo-router + safe-area are stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { C } from '../theme';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, WithQueries, refreshInAct, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';
import { transactionsRecentKey } from '../queryKeys';
import { colorOf } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ openPicker: jest.fn(), category: () => undefined })));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import AccountDetail from '../../app/account/[id]';
import { Header } from '../components/Header';

const server = installFakeServer();
useTestQueryClient();

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'PURCHASE', merchant_name: 'Shop', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};

const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: -6492.26, available_balance: 8171.88, currency: 'AUD',
  as_of: '2026-07-08T09:32:37.337Z', account_type: 'unknown', ...over,
});

beforeEach(() => {
  resetAuth();
  resetRouter();
  setParams({ id: 'a1' });
  server.seed('/transactions', [ROW]);
});

it('shows a negative balance in red and the credit-card "available" line (owe, but credit left)', async () => {
  server.seed('/accounts/balances', [bal({ amount: -6492.26, available_balance: 8171.88 })]);
  await renderWithQueries(<AccountDetail />);
  expect(colorOf(screen.getByText('-$6,492.26'))).toBe(C.bad);
  expect(screen.getByText('$8,172 available')).toBeTruthy(); // fmt() rounds
});

it('shows a positive balance in green and NO available line (spending account)', async () => {
  server.seed('/accounts/balances', [bal({ amount: 96270.59, available_balance: 96270.59, account_type: 'checking' })]);
  await renderWithQueries(<AccountDetail />);
  expect(colorOf(screen.getByText('$96,270.59'))).toBe(C.good);
  expect(screen.queryByText(/available/)).toBeNull();
});

it('hides the available line for a loan (you owe, but there is no credit to draw — available 0)', async () => {
  server.seed('/accounts/balances', [bal({ amount: -596642.43, available_balance: 0, account_type: 'mortgage' })]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('-$596,642.43')).toBeTruthy();
  expect(screen.queryByText(/available/)).toBeNull();
});

it('renders no balance hero when the account has not been polled yet', async () => {
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('1 transaction')).toBeTruthy();
  expect(screen.queryByTestId('account-balance')).toBeNull();
});

// WHIT-198 follow-up — the account-detail error state had no coverage. A hard read failure with
// NOTHING cached shows the inline error + an accessible Retry (routed through the shared
// RetryButton), and Retry re-issues the read. A failure OVER cached rows stays cache-first.
it('a hard read failure with nothing cached shows the inline error + an accessible Retry', async () => {
  server.fail('/transactions', 500);
  await renderWithQueries(<AccountDetail />);

  expect(screen.getByTestId('account-error')).toBeTruthy();
  const retry = screen.getByTestId('account-retry');
  expect(retry.props.accessibilityRole).toBe('button'); // shared RetryButton a11y contract
  expect(retry.props.accessibilityLabel).toBe('Retry loading this account');
  expect(server.sent('GET', '/transactions')).toHaveLength(1);

  fireEvent.press(retry);
  await waitFor(() => expect(server.sent('GET', '/transactions')).toHaveLength(2));
  await settle();
});

// WHIT-276 adversarial gaps (folded in) — the states that only appear when DetailStates is
// wired to the REAL account screen's data: a cold load hides the empty message, a pending list
// plus a failed taxonomy stacks both spinner and error, and a refetch failure over cached rows
// keeps the LIST. [A-acct-cache] below supersedes the old "cache-first" test (dropped WHIT-459).
it('while loading with nothing cached, shows the spinner and NOT the empty "No transactions" message', async () => {
  const held = server.hold('/transactions');
  render(<WithQueries><AccountDetail /></WithQueries>);
  await waitFor(() => expect(server.sent('GET', '/transactions')).toHaveLength(1));
  expect(screen.getByTestId('account-loading')).toBeTruthy();
  expect(screen.queryByText('No transactions')).toBeNull();
  held.release();
  await settle();
});

it('with an empty cache, a pending list plus a failed taxonomy renders BOTH the spinner and the error, no content', async () => {
  const held = server.hold('/transactions');
  server.fail('/categories', 500);
  render(<WithQueries><AccountDetail /></WithQueries>);
  await waitFor(() => expect(screen.getByTestId('account-error')).toBeTruthy());
  expect(screen.getByTestId('account-loading')).toBeTruthy();
  expect(screen.queryByText('No transactions')).toBeNull();
  held.release();
  await settle();
});

it('a background refetch failure over cached rows keeps the transaction list rendered', async () => {
  await renderWithQueries(<AccountDetail />);
  server.fail('/transactions', 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(queryClient.getQueryState(transactionsRecentKey)?.status).toBe('error');
  expect(screen.queryByTestId('account-error')).toBeNull();
  expect(screen.getByText('1 transaction')).toBeTruthy(); // cached content still on screen
});

// WHIT-643: a balance-only account (e.g. the home loan, whose few transactions are outside the
// loaded window) must still show its live balance, a readable title and a "No recent
// transactions" note. Fail-on-revert: keep the balance card inside the `detail` branch → red.
it('shows the balance for an account with a saved balance but no loaded transactions', async () => {
  setParams({ id: 'up-homeloan' });
  server.seed('/accounts/balances', [bal({ account_id: 'up-homeloan', amount: -500000, available_balance: 0, account_type: 'mortgage' })]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByTestId('account-balance')).toBeTruthy();
  expect(screen.getByText('-$500,000.00')).toBeTruthy();
  expect(screen.getByText('Up Homeloan')).toBeTruthy();
  expect(screen.getByText('No recent transactions')).toBeTruthy();
});

it('an unknown account with no balance and no transactions still shows "No transactions"', async () => {
  setParams({ id: 'nope' });
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('No transactions')).toBeTruthy();
  expect(screen.queryByTestId('account-balance')).toBeNull();
});

// [A2] an account with BOTH loaded transactions and a balance keeps the bank's name in the
// header — the id-derived fallback ("A1") is only for balance-only accounts.
it('uses the transaction account name for the header when the account also has a balance', async () => {
  server.seed('/accounts/balances', [bal()]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.UNSAFE_getByType(Header).props.title).toBe('ANZ');
});

// [A3] a balance-only account's header is its id tidied into words, not the generic "Account".
it('titles a balance-only account from its id', async () => {
  setParams({ id: 'up-homeloan' });
  server.seed('/accounts/balances', [bal({ account_id: 'up-homeloan' })]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.UNSAFE_getByType(Header).props.title).toBe('Up Homeloan');
});
