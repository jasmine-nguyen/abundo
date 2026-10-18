// WHIT-212 — the account detail screen's balance hero: shows the signed live balance
// (green in credit / red owing), the credit-card "available" line ONLY when you owe yet
// have credit left, and hides it for a loan/spending account. Runs over the fake server: the
// real useAccountTransactionsScreenData reads the seeded account feed + /accounts/balances.
// ../context is partially mocked (real selectors, stubbed useAppContext for TransactionRow);
// expo-router + safe-area are stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react-native';
import { RefreshControl, SectionList } from 'react-native';
import { C } from '../theme';
import { installFakeServer, seedFeedPage } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient, WithQueries, refreshInAct, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter, routerSpies } from './support/routerMock';
import { queryClient } from '../queryClient';
import { accountFeedKey } from '../queryKeys';
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

// The account page's own list: GET /transactions/feed?account=a1.
const FEED = '/transactions/feed';
const FIRST_PAGE = `${FEED}?account=a1`;

const bal = (over: Partial<AccountBalance> = {}) => accountBalance({
  amount: -6492.26, available_balance: 8171.88, as_of: '2026-07-08T09:32:37.337Z', account_type: 'unknown', ...over,
});

beforeEach(() => {
  resetAuth();
  resetRouter();
  setParams({ id: 'a1' });
  seedFeedPage(server, FEED, [ROW]);
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
  const held = server.hold(FEED);
  render(<WithQueries><AccountDetail /></WithQueries>);
  await waitFor(() => expect(server.sent('GET', FIRST_PAGE)).toHaveLength(1));
  expect(screen.getByTestId('account-loading')).toBeTruthy();
  expect(screen.queryByText('No transactions')).toBeNull();
  held.release();
  await settle();
});

it('a background refetch failure over cached rows keeps the transaction list rendered', async () => {
  await renderWithQueries(<AccountDetail />);
  server.fail(FEED, 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(queryClient.getQueryState([...accountFeedKey, 'a1'])?.status).toBe('error');
  expect(screen.queryByTestId('account-error')).toBeNull();
  expect(screen.getByText('−⁠$42.00')).toBeTruthy(); // cached content still on screen
});

// WHIT-643: a balance-only account (no transactions at all) must still show its live balance, a
// readable title and a "No transactions yet" note. Fail-on-revert: keep the balance card inside
// the `detail` branch → red.
it('shows the balance for an account with a saved balance but no transactions', async () => {
  setParams({ id: 'up-homeloan' });
  seedFeedPage(server, FEED, []);
  server.seed('/accounts/balances', [bal({ account_id: 'up-homeloan', amount: -500000, available_balance: 0, account_type: 'mortgage' })]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByTestId('account-balance')).toBeTruthy();
  expect(screen.getByText('$500,000.00')).toBeTruthy();
  expect(screen.getByText('Up Homeloan')).toBeTruthy();
  expect(screen.getByText('No transactions yet')).toBeTruthy();
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
  expect(screen.getByText(/ · \$42 spent$/)).toBeTruthy();

  const amount = screen.getByText('$592,994.43');
  expect(amount.props.numberOfLines).toBe(1);
  expect(amount.props.adjustsFontSizeToFit).toBe(true);
  expect(amount.props.maxFontSizeMultiplier).toBe(2);

  const listReads = server.sent('GET', FIRST_PAGE).length;
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  await waitFor(() => expect(server.sent('POST', '/accounts/balances/refresh')).toHaveLength(1));
  await waitFor(() => expect(server.sent('GET', FIRST_PAGE).length).toBeGreaterThan(listReads));
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
  seedFeedPage(server, FEED, []);
  const list = coldLoad ? server.hold(FEED) : null;
  render(<WithQueries><AccountDetail /></WithQueries>);
  await waitFor(() => expect(server.sent('GET', FIRST_PAGE)).toHaveLength(1));
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
  seedFeedPage(server, FEED, [{ ...ROW, amount: 500, category: 'income' }]);
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('Shop')).toBeTruthy();
  expect(screen.queryByText(/ · /)).toBeNull();
});

// ABU-67: the account page pages back through THIS account's whole history. It opens on the
// newest page of GET /transactions/feed?account=<id>; Load More (shown only while nextCursor is
// set) sends that cursor, a spinner shows while it loads, and the older rows join the list.
// A pull snaps back to the newest page only.
it('Load More appends this account\'s older rows, and a pull snaps back to the newest page', async () => {
  seedFeedPage(server, '/transactions/feed', [ROW], 'c1');
  await renderWithQueries(<AccountDetail />);
  const feedReads = () => server.sentUnder('GET', '/transactions/feed')
    .map((request) => new URLSearchParams(request.path.split('?')[1] ?? ''))
    .filter((params) => params.get('account') === 'a1');
  expect(feedReads().map((params) => params.get('cursor'))).toEqual([null]);
  expect(screen.getByText('−⁠$42.00')).toBeTruthy();

  const older = { ...ROW, transaction_id: 't0', date: '2025-03-04', authorized_date: '2025-03-04', amount: -7 };
  const held = server.hold('/transactions/feed');
  server.once('GET', '/transactions/feed', { body: { transactions: [older], nextCursor: null } });
  fireEvent.press(screen.getByTestId('account-load-more'));
  expect(await screen.findByTestId('account-load-more-spinner')).toBeTruthy();
  held.release();

  expect(await screen.findByText('−⁠$7.00')).toBeTruthy();
  expect(screen.getByText('−⁠$42.00')).toBeTruthy();
  const olderPage = feedReads().at(-1)!;
  expect(olderPage.get('account')).toBe('a1');
  expect(olderPage.get('cursor')).toBe('c1');
  expect(screen.queryByTestId('account-load-more')).toBeNull();

  const readsBeforePull = feedReads().length;
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  await waitFor(() => expect(screen.queryByText('−⁠$7.00')).toBeNull());
  expect(screen.getByText('−⁠$42.00')).toBeTruthy();
  expect(await screen.findByTestId('account-load-more')).toBeTruthy();
  expect(feedReads().slice(readsBeforePull).every((params) => params.get('cursor') === null)).toBe(true);
  await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
});

// [A1] ABU-58: a full first page (30 rows, each on its own day) draws every row and the Load More
// footer without scrolling, so the list's first window must also count each day's heading cells.
it('a full first page over 30 different days draws every row and Load More without scrolling', async () => {
  const page = Array.from({ length: 30 }, (_, i) => {
    const date = `2026-06-${String(i + 1).padStart(2, '0')}`;
    return { ...ROW, transaction_id: `p${i}`, date, authorized_date: date, amount: -(i + 1) };
  });
  seedFeedPage(server, FEED, page, 'c1');
  await renderWithQueries(<AccountDetail />);
  expect(screen.getByText('−⁠$30.00')).toBeTruthy();
  expect(screen.getByText('−⁠$1.00')).toBeTruthy();
  expect(screen.getByTestId('account-load-more')).toBeTruthy();
});

// ABU-99: content scrolling under the title gets a clean edge. The shared scroll hook must work on
// the account page's SectionList, not just a ScrollView.
it('scrolling the list draws the title bar edge, and scrolling back to the top removes it', async () => {
  server.seed('/accounts/balances', [bal()]);
  await renderWithQueries(<AccountDetail />);
  const list = screen.UNSAFE_getByType(SectionList);
  const edge = () => styleOf(screen.getByTestId('header-wrap')).borderBottomWidth ?? 0;
  expect(edge()).toBe(0);
  fireEvent.scroll(list, { nativeEvent: { contentOffset: { x: 0, y: 60 } } });
  expect(edge()).toBeGreaterThan(0);
  fireEvent.scroll(list, { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
  expect(edge()).toBe(0);
});

