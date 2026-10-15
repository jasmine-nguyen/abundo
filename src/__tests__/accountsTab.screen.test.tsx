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
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import { C } from '../theme';
import { Icon, ICON, GLYPH } from '../icons';
import { ACCOUNT_KIND_ICON } from '../accountDisplay';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_RECORD } from './support/categories';
import { renderWithQueries, useTestQueryClient, WithQueries, refreshInAct, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { queryClient } from '../queryClient';
import { styleOf } from './support/layout';
import { seedGoal } from './support/goalsScreen';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { pinToday } from './support/clock';

const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: 96270.59, available_balance: 96270.59, currency: 'AUD',
  as_of: '2026-07-08T09:32:02.405Z', account_type: 'checking', ...over,
});

jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockShowToast = jest.fn();
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ showToast: mockShowToast })));

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

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
  resetRouter();
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
  expect(routerSpies.push).toHaveBeenCalledWith('/account/a1');
});

it('shows the cold-load spinner (empty + loading)', async () => {
  const feed = server.hold('/transactions/feed');
  render(<WithQueries><Accounts /></WithQueries>);
  await waitFor(() => expect(feedReads()).toHaveLength(1));
  expect(screen.getByTestId('accounts-loading')).toBeTruthy();
  feed.release();
  await settle();
});

it('keeps its cards through a background error when txns are cached (cache-first)', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]);
  await renderWithQueries(<Accounts />);
  server.fail('/transactions/feed', 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('accounts-error')).toBeNull();
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
  expect(styleOf(screen.getByText('$500,000.00')).color).toBe(C.textBright);
  expect(screen.getByText('owed')).toBeTruthy();
  // ABU-64: with no payoff plan set up, the loan card points inside instead of "No recent transactions".
  expect(screen.getByText('Home loan · payoff inside')).toBeTruthy();
  fireEvent.press(screen.getByText('Up Homeloan'));
  expect(routerSpies.push).toHaveBeenCalledWith('/account/up-homeloan');
});

// ABU-64: the home loan's card (spotted by account_type 'mortgage') shows its payoff progress, from
// the same next-milestone maths as the Home loan screen, while other cards keep their own line.
// Balance $250,000 against the saved plan's next target ($200,000) → $50,000 to go.
it('the home loan card shows the next payoff milestone; other cards keep their own subtitle', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]);
  server.seed('/accounts/balances', [
    bal({ account_id: 'a1', amount: 96270.59 }),
    bal({ account_id: 'up-homeloan', amount: -250000, available_balance: 0, account_type: 'mortgage' }),
  ]);
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 250000, asOf: '2026-07-04T00:00:00Z' } });
  await renderWithQueries(<Accounts />);
  expect(await screen.findByText('Next milestone: $50,000 to go')).toBeTruthy();
  expect(screen.getByText(/^Last spend /)).toBeTruthy();
  expect(screen.queryByText('No recent spending')).toBeNull();
  fireEvent.press(screen.getByText('Up Homeloan'));
  expect(routerSpies.push).toHaveBeenCalledWith('/account/up-homeloan');
});

// [A1] ABU-64: the payoff reads fire only when a balance is the home loan, so the tab costs nothing
// extra without one. Fail-on-revert: drop the `enabled` gate → the reads fire.
it('does not read the home-loan data when no balance is a mortgage', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]);
  server.seed('/accounts/balances', [bal({ account_id: 'a1' })]);
  await renderWithQueries(<Accounts />);
  expect(screen.getByText('ANZ')).toBeTruthy();
  for (const path of ['/homeloan', '/loanfacts', '/milestones']) expect(server.sentUnder('GET', path)).toHaveLength(0);
});

// [A2] ABU-64: the payoff line is secondary: a failed home-loan read keeps the loan card's fallback
// subtitle and never surfaces the tab's error state.
it('a failed home-loan read keeps the loan card with its fallback subtitle', async () => {
  seedFeed([{ ...ROW, account_id: 'a1', account_name: 'ANZ' }]);
  server.seed('/accounts/balances', [bal({ account_id: 'up-homeloan', amount: -250000, account_type: 'mortgage' })]);
  seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 250000, asOf: '2026-07-04T00:00:00Z' } });
  server.fail('/homeloan', 500);
  await renderWithQueries(<Accounts />);
  await waitFor(() => expect(server.sentUnder('GET', '/homeloan').length).toBeGreaterThan(0));
  await settle();
  expect(screen.getByText('Home loan · payoff inside')).toBeTruthy();
  expect(screen.getByText('ANZ')).toBeTruthy();
});

it('with no loaded transactions but a saved balance, shows the card, not "No accounts yet"', async () => {
  server.seed('/accounts/balances', [bal({ account_id: 'up-homeloan', amount: -500000 })]);
  await renderWithQueries(<Accounts />);
  expect(screen.queryByText('No accounts yet')).toBeNull();
  expect(screen.getByText('Up Homeloan')).toBeTruthy();
});

// ABU-65 (reworks WHIT-490): the four real accounts keep a fixed place, icon and colour. Order is by
// type (cards → everyday → home loan, then name), the icon follows the type, and the colour follows
// the account id, so a busier day never reshuffles or recolours them. Owing money reads as bright
// neutral text plus "owed", never alarm rose; money in stays C.good. Subtitles are useful facts.
it('shows the four accounts in a fixed order, icon and colour, with owed balances and useful subtitles', async () => {
  pinToday(new Date(2026, 6, 8, 12, 0, 0));
  const row = (over: Record<string, unknown>) => ({ ...ROW, ...over });
  const spending = (n: number, date: string) =>
    row({ transaction_id: `s${n}`, account_id: 'up-spending', account_name: 'Up Spending', date, authorized_date: date });
  const feed = [
    spending(1, '2026-07-05'),
    spending(2, '2026-07-08'),
    row({ transaction_id: 'a1', account_id: 'anz-rewards-black-visa', account_name: 'ANZ Rewards Black Visa' }),
    row({ transaction_id: 'h1', account_id: 'up-homeloan', account_name: 'Up Homeloan' }),
    row({
      transaction_id: 'bank_tx_b220e370', account_id: 'westpac-altitude-qantas-black',
      account_name: 'Altitude Qantas Black Card', merchant_name: 'UNIFLEXREMEDIALMASSAGE',
      description: 'UNIFLEXREMEDIALMASSAGE ALTONA NORT AUS', amount: -155, category: 'health',
    }),
  ];
  seedFeed(feed);
  server.seed('/accounts/balances', [
    bal({ account_id: 'up-spending', amount: 96270.59 }),
    bal({ account_id: 'anz-rewards-black-visa', amount: -6492.26, available_balance: 4549, account_type: 'unknown' }),
    bal({ account_id: 'up-homeloan', amount: -596642.43, available_balance: 0, account_type: 'mortgage' }),
    bal({ account_id: 'westpac-altitude-qantas-black', amount: -230, available_balance: 5770, account_type: 'unknown' }),
  ]);
  try {
    await renderWithQueries(<Accounts />);

    const names = ['Altitude Qantas Black Card', 'ANZ Rewards Black Visa', 'Up Spending', 'Up Homeloan'];
    const cardOrder = () => screen.getAllByRole('button')
      .map((b) => b.props.accessibilityLabel as string | undefined)
      .map((label) => names.find((name) => label?.startsWith(`${name},`)))
      .filter(Boolean);
    expect(cardOrder()).toEqual(names);

    const chips = () => screen.UNSAFE_getAllByType(Icon)
      .map((i) => i.props as { name: string; color: string })
      .filter((p) => ['card', 'wallet', 'home', 'bank'].includes(p.name));
    expect(chips().map((p) => p.name)).toEqual(['card', 'card', 'wallet', 'home']);
    const colours = chips().map((p) => p.color);
    expect(new Set(colours).size).toBe(4);
    for (const colour of colours) expect([C.good, C.bad, C.surplus]).not.toContain(colour);

    expect(styleOf(screen.getByText('$6,492.26')).color).toBe(C.textBright);
    expect(styleOf(screen.getByText('$596,642.43')).color).toBe(C.textBright);
    expect(styleOf(screen.getByText('$96,270.59')).color).toBe(C.good);
    expect(screen.getAllByText('owed')).toHaveLength(3);

    expect(screen.getByText('$4,549 available')).toBeTruthy();
    expect(screen.getByText('$5,770 available')).toBeTruthy();
    expect(screen.getByText('Last spend today')).toBeTruthy();
    expect(screen.getByText('Home loan · payoff inside')).toBeTruthy();

    // A busier day for the home loan (now the most rows) changes neither the order nor the colours.
    seedFeed([...feed, ...[2, 3, 4].map((n) => row({ transaction_id: `h${n}`, account_id: 'up-homeloan', account_name: 'Up Homeloan' }))]);
    await refreshInAct(() => queryClient.refetchQueries());
    expect(cardOrder()).toEqual(names);
    expect(chips().map((p) => p.color)).toEqual(colours);
  } finally {
    jest.useRealTimers();
  }
});

// ABU-65: Icon looks a name up in ICON then GLYPH; a name in neither silently draws the "?" fallback.
it('every account-type chip icon is a real drawing', () => {
  for (const name of Object.values(ACCOUNT_KIND_ICON)) expect(ICON[name] ?? GLYPH[name]).toBeDefined();
});

// ABU-66: the header shows "Updated … · Bank synced …" like Transactions, and each account card is
// a labelled button: name and balance, or "balance not loaded yet" before the first poll.
it('shows the Updated + Bank synced line, and each card is a button labelled with name and balance', async () => {
  server.seed('/transactions/feed', {
    transactions: [
      { ...ROW, transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' },
      { ...ROW, transaction_id: 't2', account_id: 'a2', account_name: 'Up Spending' },
    ],
    nextCursor: null,
    bankSyncedAt: { a1: new Date('2026-07-08T09:12:00+10:00').getTime() },
  });
  server.seed('/accounts/balances', [bal({ account_id: 'a1', amount: 96270.59 })]);
  await renderWithQueries(<Accounts />);
  await waitFor(() => expect(screen.getByTestId('accounts-updated')).toBeTruthy());
  expect(screen.getByTestId('accounts-bank-synced-a1')).toBeTruthy();

  const labels = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel as string | undefined);
  expect(labels.find((label) => label?.startsWith('ANZ'))).toContain('$96,270.59');
  expect(labels.find((label) => label?.startsWith('Up Spending'))).toContain('balance not loaded yet');
});
