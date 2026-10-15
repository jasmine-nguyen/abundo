// WHIT-212 — the account detail screen's balance hero: shows the signed live balance
// (green in credit / red owing), the credit-card "available" line ONLY when you owe yet
// have credit left, and hides it for a loan/spending account. Runs over the fake server: the
// real useRecentTransactionsScreenData reads the seeded GET /transactions + /accounts/balances.
// ../context is partially mocked (real selectors, stubbed useAppContext for TransactionRow);
// expo-router + safe-area are stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import { C, MINUS } from '../theme';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, WithQueries, refreshInAct, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter, routerSpies } from './support/routerMock';
import { queryClient } from '../queryClient';
import { transactionsRecentKey } from '../queryKeys';
import { styleOf } from './support/layout';
import { accountBalance } from './support/accountBalance';
import type { AccountBalance } from '../api';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
const mockShowToast = jest.fn();
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ openPicker: jest.fn(), category: () => undefined, showToast: mockShowToast })));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import AccountDetail from '../../app/account/[id]';
import { Header } from '../components/Header';

const server = installFakeServer();
useTestQueryClient();

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'PURCHASE', merchant_name: 'Shop', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};

const bal = (over: Partial<AccountBalance> = {}) => accountBalance({
  amount: -6492.26, available_balance: 8171.88, as_of: '2026-07-08T09:32:37.337Z', account_type: 'unknown', ...over,
});

beforeEach(() => {
  resetAuth();
  resetRouter();
  setParams({ id: 'a1' });
  server.seed('/transactions', [ROW]);
});

it('shows an owed balance in bright neutral text with "owed", and the credit-card "available" line', async () => {
  server.seed('/accounts/balances', [bal({ amount: -6492.26, available_balance: 8171.88 })]);
  await renderWithQueries(<AccountDetail />);
  expect(styleOf(screen.getByText('$6,492.26')).color).toBe(C.textBright);
  expect(screen.getByText('owed')).toBeTruthy();
  expect(screen.getByText('$8,172 available')).toBeTruthy(); // fmt() rounds
});

it('shows a positive balance in green and NO available line (spending account)', async () => {
  server.seed('/accounts/balances', [bal({ amount: 96270.59, available_balance: 96270.59, account_type: 'checking' })]);
  await renderWithQueries(<AccountDetail />);
  expect(styleOf(screen.getByText('$96,270.59')).color).toBe(C.good);
  expect(screen.queryByText(/available/)).toBeNull();
});

it('hides the available line for a loan (you owe, but there is no credit to draw — available 0)', async () => {
  server.seed('/accounts/balances', [bal({ amount: -596642.43, available_balance: 0, account_type: 'mortgage' })]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('$596,642.43')).toBeTruthy();
  expect(screen.queryByText(/available/)).toBeNull();
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
  expect(screen.getByText('$500,000.00')).toBeTruthy();
  expect(screen.getByText('Up Homeloan')).toBeTruthy();
  expect(screen.getByText('No recent transactions')).toBeTruthy();
});

// ABU-64: only the home loan (account_type 'mortgage') gets the "See payoff progress" row, which
// opens the Home loan screen. Every account's balance age shows as the shared freshness tag, in
// the readable card tone (textMid), instead of the plain "as of" line.
it.each([
  ['mortgage', true],
  ['checking', false],
])('a %s account: payoff link shown = %s, and the freshness tag replaces "as of"', async (accountType, isLoan) => {
  server.seed('/accounts/balances', [bal({ amount: -500000, available_balance: 0, account_type: accountType })]);
  await renderWithQueries(<AccountDetail />);
  const pill = screen.getByTestId('balance-freshness');
  expect(styleOf(within(pill).getByText(/^As of/)).color).toBe(C.textMid);
  expect(screen.queryByText(/^as of/)).toBeNull();
  if (!isLoan) {
    expect(screen.queryByTestId('account-payoff-link')).toBeNull();
    return;
  }
  const link = screen.getByTestId('account-payoff-link');
  expect(within(link).getByText('See payoff progress')).toBeTruthy();
  fireEvent.press(link);
  expect(routerSpies.push).toHaveBeenCalledWith('/mortgage');
});

// [A2] an account with BOTH loaded transactions and a balance keeps the bank's name in the
// header — the id-derived fallback ("A1") is only for balance-only accounts.
it('uses the transaction account name for the header when the account also has a balance', async () => {
  server.seed('/accounts/balances', [bal()]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.UNSAFE_getByType(Header).props.title).toBe('ANZ');
});

// ABU-66: the account page matches Transactions. A pull re-reads the list and fetches live
// balances (spinner clears after), each day heading carries its total, and the big balance
// stays on one line, shrinking to fit under the large-text cap.
it('pull refreshes the list and live balances, headings show the day total, balance shrinks to fit', async () => {
  server.seed('/accounts/balances', [bal({ amount: -592994.43, available_balance: 0 })]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText(new RegExp(` · ${MINUS}\\$42$`))).toBeTruthy();

  const amount = screen.getByText('$592,994.43');
  expect(amount.props.numberOfLines).toBe(1);
  expect(amount.props.adjustsFontSizeToFit).toBe(true);
  expect(amount.props.maxFontSizeMultiplier).toBe(2);

  const listReads = server.sent('GET', '/transactions').length;
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  await waitFor(() => expect(server.sent('POST', '/accounts/balances/refresh')).toHaveLength(1));
  await waitFor(() => expect(server.sent('GET', '/transactions').length).toBeGreaterThan(listReads));
  await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
});

// [A1] the account page's pull puts the live number on screen and confirms it (the failure path
// is the shared hook's, covered in usePullToRefresh.screen.test.tsx). Fail-on-revert: drop
// refreshLiveBalances / the success message from [id].tsx's usePullToRefresh → the balance stays
// -$100.00 or the toast never fires.
it('a pull whose live balance call succeeds shows the live balance and confirms it', async () => {
  server.seed('/accounts/balances', [bal({ amount: -100, available_balance: 0 })]);
  server.once('POST', '/accounts/balances/refresh', { body: [bal({ amount: -250, available_balance: 0 })] });
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('$100.00')).toBeTruthy();
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Balances up to date'));
  expect(await screen.findByText('$250.00')).toBeTruthy();
  expect(mockShowToast).toHaveBeenCalledTimes(1);
});

// [A2] WHIT-363 on the account page: a pull during the cold load leaves the inline spinner alone
// (no second spinner); a pull on a settled empty page does spin. Fail-on-revert: `refreshing={pulling}`
// → the cold-load row reds; gating on `transactions.length > 0` → the settled-empty row reds.
it.each([
  ['during the cold load', true, false],
  ['on a settled empty page', false, true],
])('a pull %s: pull spinner shown = %s', async (_name, coldLoad, spinning) => {
  server.seed('/transactions', []);
  const list = coldLoad ? server.hold('/transactions') : null;
  render(<WithQueries><AccountDetail /></WithQueries>);
  await waitFor(() => expect(server.sent('GET', '/transactions')).toHaveLength(1));
  if (!coldLoad) await waitFor(() => expect(screen.getByText('No transactions')).toBeTruthy());
  const liveRefresh = server.hold('/accounts/balances/refresh');
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  await waitFor(() => expect(server.sent('POST', '/accounts/balances/refresh')).toHaveLength(1));
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(spinning);
  liveRefresh.release();
  list?.release();
  await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
  await settle();
});

// [A3] a day with nothing counted to spend (income only) shows the bare day label, no " · total".
// Fail-on-revert: always append the total in DayHeading → "… · null" shows.
it('a day heading with no spend shows only the day label', async () => {
  server.seed('/transactions', [{ ...ROW, amount: 500, category: 'income' }]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('1 transaction')).toBeTruthy();
  expect(screen.queryByText(/ · /)).toBeNull();
});

