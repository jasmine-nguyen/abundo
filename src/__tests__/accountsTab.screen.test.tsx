// The Accounts tab, now its own bottom-bar screen (moved out of the Transactions segmented
// control). These assertions were relocated from transactionsScreenStates.screen.test.tsx:
// they render app/(tabs)/accounts directly — the cards show on mount, so there is no segment
// to press. The accounts view DERIVES from the transactions feed (one card per account_id)
// and shows the live poller-fed balance per card. Runs over the fake server: the real
// useTransactionsScreenData reads the seeded GET /transactions/feed + /accounts/balances.
// `../context` keeps the real selectors with a stubbed useAppContext. Fail-on-revert: dropping
// `transactions.length === 0` from showError makes the "error with cached cards" case surface
// the error.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { StyleSheet, RefreshControl } from 'react-native';
import { C } from '../theme';
import { Icon } from '../icons';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_RECORD } from './support/categories';
import { renderWithQueries, useTestQueryClient, WithQueries, refreshInAct, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { queryClient } from '../queryClient';

const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: 96270.59, available_balance: 96270.59, currency: 'AUD',
  as_of: '2026-07-08T09:32:02.405Z', account_type: 'checking', ...over,
});
const colorOf = (node: unknown) => (StyleSheet.flatten((node as { props: { style?: unknown } }).props.style) as { color?: string }).color;

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockShowToast = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ showToast: mockShowToast }),
  };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: mockPush }),
  };
});

import Accounts from '../../app/(tabs)/accounts';

const server = installFakeServer();
useTestQueryClient();

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};

const seedFeed = (transactions: unknown[]) => server.seed('/transactions/feed', { transactions, nextCursor: null });
const feedReads = () => server.sentUnder('GET', '/transactions/feed');

beforeEach(() => {
  mockPush.mockClear();
  mockShowToast.mockClear();
  resetAuth();
  server.seed('/categories', [GROCERIES_RECORD]);
});

it('derives one card per account_id from the transactions (consistent name)', async () => {
  const anz = { ...ROW, transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' };
  const up = { ...ROW, transaction_id: 't2', account_id: 'a2', account_name: 'Up Homeloan' };
  const up2 = { ...ROW, transaction_id: 't3', account_id: 'a2', account_name: 'Up Homeloan' };
  seedFeed([anz, up, up2]);
  await renderWithQueries(<Accounts />);
  // One card per account; the Up account (2 txns) collapses to a single consistent name.
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.getAllByText('Up Homeloan')).toHaveLength(1);
});

it('tapping an account card navigates to that account\'s detail route', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]);
  await renderWithQueries(<Accounts />);
  fireEvent.press(screen.getByText('ANZ'));
  expect(mockPush).toHaveBeenCalledWith('/account/a1');
});

it('shows the cold-load spinner (empty + loading)', async () => {
  const feed = server.hold('/transactions/feed');
  render(<WithQueries><Accounts /></WithQueries>);
  await waitFor(() => expect(feedReads()).toHaveLength(1));
  expect(screen.getByTestId('accounts-loading')).toBeTruthy();
  feed.release();
  await settle();
});

it('shows the inline retry on a cold error (empty + error), and Retry re-reads the feed', async () => {
  server.fail('/transactions/feed', 500);
  await renderWithQueries(<Accounts />);
  expect(screen.getByTestId('accounts-error')).toBeTruthy();
  expect(feedReads()).toHaveLength(1);
  fireEvent.press(screen.getByTestId('accounts-retry'));
  await waitFor(() => expect(feedReads()).toHaveLength(2));
  await settle();
});

it('a cold error says why: offline when the connection drops', async () => {
  server.once('GET', '/transactions/feed', 'dropped');
  await renderWithQueries(<Accounts />);
  expect(screen.getByTestId('accounts-error')).toHaveTextContent(/You look offline\. Check your connection and retry\./);
});

it('a cold error says why: our server when it answers 5xx', async () => {
  server.fail('/transactions/feed', 503);
  await renderWithQueries(<Accounts />);
  expect(screen.getByTestId('accounts-error')).toHaveTextContent(/Our server had a problem\. Try again in a moment\./);
});

it('keeps its cards through a background error when txns are cached (cache-first)', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]);
  await renderWithQueries(<Accounts />);
  server.fail('/transactions/feed', 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('accounts-error')).toBeNull();
});

it('settled with no transactions shows the empty state', async () => {
  await renderWithQueries(<Accounts />);
  expect(screen.getByText('No accounts yet')).toBeTruthy();
});

it('an account card shows its live balance — green when in credit (amount >= 0)', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'Up Spending' }]);
  server.seed('/accounts/balances', [bal({ amount: 96270.59 })]);
  await renderWithQueries(<Accounts />);
  const label = screen.getByText('$96,270.59'); // bare, no + sign
  expect(colorOf(label)).toBe(C.good);
});

it('an account card shows a negative balance in red (money owed)', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'Up Homeloan' }]);
  server.seed('/accounts/balances', [bal({ amount: -596642.43 })]);
  await renderWithQueries(<Accounts />);
  const label = screen.getByText('-$596,642.43');
  expect(colorOf(label)).toBe(C.bad);
});

it('an account with no balance yet shows a dim "—" placeholder', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]); // balances not polled yet
  await renderWithQueries(<Accounts />);
  expect(screen.getByText('—')).toBeTruthy();
});

// R2: a pull on the settled "No accounts yet" empty list must still show the spinner. The fill
// makes that short state pullable, so gating the spinner on `transactions.length > 0` left the
// pull feeling dead (refresh ran, no feedback). `!showSpinner` shows it whenever the cold-load
// spinner isn't already owning the screen. Fail-on-revert: restore the `length > 0` gate → an
// empty-list pull reports refreshing=false → red.
it('shows the pull spinner when pulling the settled empty list', async () => {
  await renderWithQueries(<Accounts />);
  expect(screen.getByText('No accounts yet')).toBeTruthy();
  // Hold the live balance refresh open so `refreshing` stays observable while in flight.
  const liveRefresh = server.hold('/accounts/balances/refresh');
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  await waitFor(() => expect(server.sent('POST', '/accounts/balances/refresh')).toHaveLength(1));
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
  liveRefresh.release();
  await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
});

// WHIT-489 divergent gate (the OTHER half): the Accounts RefreshControl gates on
// `pulling && !showSpinner`, so a pull DURING a cold load (empty + loading → showSpinner=true)
// must NOT raise the pull spinner — the centred inline cold-load spinner (accounts-loading) owns
// that window; the two must never double-spin. The sibling above proves settled-empty → DOES spin.
// Fail-on-revert: change accounts.tsx to `refreshing={pulling}` (drop `&& !showSpinner`) → a
// cold-load pull reports refreshing=true alongside accounts-loading → RED.
it('does NOT raise the pull spinner during a cold load (inline spinner owns it)', async () => {
  const feed = server.hold('/transactions/feed');
  const liveRefresh = server.hold('/accounts/balances/refresh');
  render(<WithQueries><Accounts /></WithQueries>);
  await waitFor(() => expect(feedReads()).toHaveLength(1));
  expect(screen.getByTestId('accounts-loading')).toBeTruthy(); // inline cold-load spinner is up
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  await waitFor(() => expect(server.sent('POST', '/accounts/balances/refresh')).toHaveLength(1)); // the pull DID fire
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false); // ...but gated off
  liveRefresh.release();
  feed.release();
  await settle();
});

// WHIT-643: the home loan gets ~2 transactions a month, so it usually isn't in the newest
// loaded window — but the balance poller has saved its balance. The tab must still show a card
// for every account in the balances payload, not only accounts seen in the loaded transactions.
// Fail-on-revert: derive cards from transactions only → no "Up Homeloan" card → red.
it('shows a card for a balance-only account (no loaded transactions) with its live balance', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]);
  server.seed('/accounts/balances', [
    bal({ account_id: 'a1', amount: 96270.59 }),
    bal({ account_id: 'up-homeloan', amount: -500000, account_type: 'mortgage' }),
  ]);
  await renderWithQueries(<Accounts />);
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.getByText('Up Homeloan')).toBeTruthy();
  expect(colorOf(screen.getByText('-$500,000.00'))).toBe(C.bad);
  expect(screen.getByText('No recent transactions')).toBeTruthy();
  fireEvent.press(screen.getByText('Up Homeloan'));
  expect(mockPush).toHaveBeenCalledWith('/account/up-homeloan');
});

it('with no loaded transactions but a saved balance, shows the card, not "No accounts yet"', async () => {
  server.seed('/accounts/balances', [bal({ account_id: 'up-homeloan', amount: -500000 })]);
  await renderWithQueries(<Accounts />);
  expect(screen.queryByText('No accounts yet')).toBeNull();
  expect(screen.getByText('Up Homeloan')).toBeTruthy();
});

// WHIT-490 (folded in from westpacAccountsTab) — the one behaviour a FOURTH account newly
// requires: the chip colour is ACCOUNT_ACCENTS[i % length], so shrink the palette to three and
// card 4 wears card 1's colour, and the two read as the same account at a glance.
it('gives the fourth account its own accent colour instead of reusing the first', async () => {
  const row = (over: Record<string, unknown>) => ({ ...ROW, ...over });
  seedFeed([
    row({ transaction_id: 's1', account_id: 'up-spending', account_name: 'Up Spending' }),
    row({ transaction_id: 'a1', account_id: 'anz-rewards-black-visa', account_name: 'ANZ Rewards Black Visa' }),
    row({ transaction_id: 'h1', account_id: 'up-homeloan', account_name: 'Up Homeloan' }),
    row({
      transaction_id: 'bank_tx_b220e370', account_id: 'westpac-altitude-qantas-black',
      account_name: 'Altitude Qantas Black Card', merchant_name: 'UNIFLEXREMEDIALMASSAGE',
      description: 'UNIFLEXREMEDIALMASSAGE ALTONA NORT AUS', amount: -155, category: 'health',
    }),
  ]);
  server.seed('/accounts/balances', [
    bal({ account_id: 'up-spending', amount: 96270.59 }),
    bal({ account_id: 'anz-rewards-black-visa', amount: -6492.26 }),
    bal({ account_id: 'up-homeloan', amount: -596642.43 }),
    bal({ account_id: 'westpac-altitude-qantas-black', amount: -230, available_balance: 5770 }),
  ]);
  await renderWithQueries(<Accounts />);

  // Filtered by name: the account chip is the only "bank" Icon today, but any future
  // chrome icon would otherwise break this with a baffling message.
  const chips = screen.UNSAFE_getAllByType(Icon).filter((i) => (i.props as { name: string }).name === 'bank');
  expect(chips).toHaveLength(4);
  expect(new Set(chips.map((i) => (i.props as { color: string }).color)).size).toBe(4);
});
