// WHIT-190a — Transactions screen STATE GATING (gaps): the showSpinner/showError
// length===0 guards (cache-first: keep rows through a background refetch / an error)
// and the empty states. The screen and its data code are real, over the pretend server
// (WHIT-686): each state is driven by what the server answers (seed / fail / hold / once).
// ../context is partially mocked (real selectors, stubbed useAppContext for the writers).
// Fail-on-revert: dropping `transactions.length === 0` from showError makes the "error with
// cached rows" case surface the error.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react-native';
import { pullControl } from './support/pull';

const mockOpenMultiPicker = jest.fn();
const mockShowToast = jest.fn();
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({
    retryLoad: jest.fn(),
    openPicker: jest.fn(),
    openMultiPicker: mockOpenMultiPicker,
    showToast: mockShowToast,
  })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer, seedFeedPage } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, WithQueries, settle } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { transactionsKey, uncategorizedCountKey } from '../queryKeys';
import { COFFEE_RECORD, GROCERIES_TOP } from './support/categories';
import { textOf, styleOf } from './support/layout';
import { C, tint } from '../theme';
import { LARGE_TEXT_MAX_SCALE } from '../hooks/useLargeText';

const server = installFakeServer();
useTestQueryClient();

const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';
const CATEGORIES = '/categories';
const BALANCES = '/accounts/balances';
const REFRESH = '/accounts/balances/refresh';

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};

const gets = (path: string) => server.sentUnder('GET', path).filter((request) => request.path.split('?')[0] === path).length;

// Under fake timers the first reads can still be settling when renderWithQueries returns.
async function draw() {
  await renderWithQueries(<Transactions />);
  await waitFor(() => expect(screen.queryByTestId('transactions-loading')).toBeNull());
}

const refreshControl = () => pullControl();
const isSpinning = () => refreshControl().props.refreshing;
// Fire the RefreshControl's onRefresh the way a user pull does, flushing the state update.
const pull = () => act(async () => { refreshControl().props.onRefresh(); });

beforeEach(() => {
  resetAuth();
  mockOpenMultiPicker.mockClear();
  mockShowToast.mockClear();
  server.seed(CATEGORIES, [GROCERIES_TOP]);
  seedFeedPage(server, FEED, []);
});
afterEach(() => { jest.useRealTimers(); });

it('error WITH cached rows keeps the rows and shows NO inline error (cache-first)', async () => {
  seedFeedPage(server, FEED, [ROW]);
  await draw();
  server.once('GET', FEED, { status: 500 });
  await refreshInAct(() => queryClient.refetchQueries({ queryKey: transactionsKey }));
  expect(queryClient.getQueryState(transactionsKey)?.status).toBe('error');
  expect(screen.getByText('−\u2060$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});

it('a background load (isLoading) with cached rows does NOT blank the list', async () => {
  seedFeedPage(server, FEED, [ROW]);
  const held = server.hold(CATEGORIES); // the taxonomy is still loading while the rows are in
  await render(<WithQueries><Transactions /></WithQueries>);
  expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-loading')).toBeNull();
  held.release();
  await settle();
});

it('empty + error shows the inline retry, and Retry re-reads the list and the stored balances', async () => {
  server.fail(FEED, 500);
  await draw();
  expect(screen.getByTestId('transactions-error')).toBeTruthy();
  // WHIT-844: not "Updated <time>" from the categories' load alone (the feed never loaded).
  expect(screen.queryByTestId('transactions-updated')).toBeNull();
  const feedBefore = gets(FEED);
  const balancesBefore = gets(BALANCES);
  await fireEvent.press(screen.getByTestId('transactions-retry'));
  await waitFor(() => expect(gets(FEED)).toBe(feedBefore + 1));
  await waitFor(() => expect(gets(BALANCES)).toBe(balancesBefore + 1));
  await settle();
});

it('empty + error says why: offline when the connection drops, our server on a 5xx', async () => {
  server.once('GET', FEED, 'dropped');
  await draw();
  expect(screen.getByTestId('transactions-error')).toHaveTextContent(/You look offline\. Check your connection and retry\./);
  server.once('GET', FEED, { status: 503 });
  await fireEvent.press(screen.getByTestId('transactions-retry'));
  await waitFor(() => expect(screen.getByTestId('transactions-error')).toHaveTextContent(/Our server had a problem\. Try again in a moment\./));
});

it('empty + loading shows the spinner', async () => {
  const held = server.hold(FEED);
  await render(<WithQueries><Transactions /></WithQueries>);
  await waitFor(() => expect(gets(FEED)).toBe(1));
  expect(screen.getByTestId('transactions-loading')).toBeTruthy();
  held.release();
  await settle();
  await waitFor(() => expect(screen.queryByTestId('transactions-loading')).toBeNull());
});

// WHIT-844: while the Uncategorized list is still cold-loading, the categories' load time alone
// mustn't read as "Updated <time>" over the spinner.
it('a cold-loading Uncategorized tab shows the spinner and no "Updated" line', async () => {
  await draw();
  expect(screen.getByTestId('transactions-updated')).toBeTruthy();
  const held = server.hold(UNCATEGORIZED_FEED);
  await fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByTestId('transactions-loading')).toBeTruthy();
  expect(screen.queryByTestId('transactions-updated')).toBeNull();
  held.release();
  await settle();
  expect(await screen.findByTestId('transactions-updated')).toBeTruthy();
});

// [A3] The line sits directly under the search box: above the Uncategorized hint, not below it.
it('[A3] the "Updated" line renders above the Uncategorized hint', async () => {
  seedFeedPage(server, UNCATEGORIZED_FEED, [{ ...ROW, category: null }]);
  await draw();
  await fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByText(/Tap a transaction to categorise it/)).toBeTruthy();
  const text = textOf(screen.container);
  expect(text.indexOf('Updated ')).toBeGreaterThan(-1);
  expect(text.indexOf('Updated ')).toBeLessThan(text.indexOf('Tap a transaction to categorise it'));
});

// WHIT-846: the tabs are the shared soft-tint switch (not a solid white pill), 44pt tall, with a
// rose count bubble; on-screen words use Australian spelling; an unfiled row's label is rose.
it('the tabs use the soft tint, Australian spelling and a rose Uncategorised row', async () => {
  seedFeedPage(server, FEED, [{ ...ROW, category: null }]);
  server.seed(COUNT, { count: 1 });
  await draw();
  const allTab = screen.getByTestId('tab-all');
  expect(allTab.props.accessibilityState.selected).toBe(true);
  expect(styleOf(allTab).backgroundColor).toBe(tint(C.accentAlt, 0.16));
  expect(styleOf(within(allTab).getByText('All'))).toMatchObject({ color: C.accentSoft, fontWeight: '700' });
  const uncategorisedTab = screen.getByTestId('tab-uncategorized');
  for (const tab of [allTab, uncategorisedTab]) expect(styleOf(tab).minHeight).toBeGreaterThanOrEqual(44);
  expect(within(uncategorisedTab).getByText('Uncategorised')).toBeTruthy();
  expect(await within(uncategorisedTab).findByText('1')).toBeTruthy();
  const rowLabel = (await screen.findAllByText('Uncategorised'))
    .find((node) => uncategorisedTab.queryAll((candidate) => candidate === node).length === 0);
  expect(rowLabel).toBeTruthy();
  expect(styleOf(rowLabel!).color).toBe(C.bad);
  expect(screen.queryByText(/Uncategorized|categorize/)).toBeNull();
});

it('empty Uncategorized tab (settled) shows the "All caught up" empty state', async () => {
  await draw();
  await fireEvent.press(screen.getByText('Uncategorised'));
  expect(await screen.findByText('All caught up')).toBeTruthy();
});

// [A1] ABU-100: through the on-screen-only list, each day heading still sits above its own rows,
// newest day first, with the controls above and Load More below.
it('the rows sit under their own day heading, between the controls and Load More', async () => {
  seedFeedPage(server, FEED, [
    { ...ROW, transaction_id: 'new', date: '2026-07-02', authorized_date: '2026-07-02', amount: -7 },
    { ...ROW, transaction_id: 'old', amount: -42 },
  ], 'c1');
  await draw();
  const text = textOf(screen.container);
  const order = ['Uncategorised', 'Thu 2 Jul', '−⁠$7.00', 'Wed 1 Jul', '−⁠$42.00', 'Load More'];
  const at = order.map((part) => text.indexOf(part));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
});

// ===== Load More (folded from transactionsLoadMore.screen.test.tsx) =====
// The Transactions tab "Load More" control: the feed's `nextCursor` decides whether there is more
// history, and a tap sends the next feed read with that cursor.
describe('Transactions — Load More', () => {
const row = (id: string) => ({ ...ROW, transaction_id: id });

it('shows Load More when there is more history, and tapping it pages older rows in', async () => {
  seedFeedPage(server, FEED, [row('t1')], 'c1');
  await draw();
  server.once('GET', FEED, { body: { transactions: [{ ...row('t2'), amount: -7 }], nextCursor: null } });
  await fireEvent.press(screen.getByTestId('transactions-load-more'));
  expect(await screen.findByText('−\u2060$7.00')).toBeTruthy();
  expect(server.sent('GET', '/transactions/feed?cursor=c1')).toHaveLength(1);
  expect(screen.getByText('−\u2060$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-load-more')).toBeNull(); // end of history now
});

// WHIT: on the Uncategorized tab, when everything is filed ("All caught up"), Load More must
// not render even though older history still exists — there's nothing to page toward there.
it('hides Load More on the uncategorized "all caught up" empty state, even with more history', async () => {
  seedFeedPage(server, FEED, [row('t1')], 'c1');
  seedFeedPage(server, UNCATEGORIZED_FEED, [], 'c1'); // the server count is 0 -> the empty state shows
  await draw();
  await fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByText('All caught up')).toBeTruthy();
  expect(screen.queryByTestId('transactions-load-more')).toBeNull(); // fail-on-revert: reappears without the guard
});

// The guard is the EMPTY case, not the whole tab: with real uncategorized rows showing, Load
// More still pages older history (so a buried uncategorized charge isn't stranded).
it('keeps Load More on the uncategorized tab when there ARE uncategorized rows', async () => {
  seedFeedPage(server, UNCATEGORIZED_FEED, [{ ...row('t1'), category: null }], 'c1');
  server.seed(COUNT, { count: 1 });
  await draw();
  await fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();
  expect(screen.queryByText('All caught up')).toBeNull();
  expect(screen.getByTestId('transactions-load-more')).toBeTruthy();
  // WHIT-845: the badge number caps at 2× text, like the rest of the row.
  expect(within(screen.getByTestId('tab-uncategorized')).getByText('1').props.maxFontSizeMultiplier).toBe(LARGE_TEXT_MAX_SCALE);
});
});

// ===== WHIT-363 pull-to-refresh (folded from transactionsPullRefresh.screen.test.tsx) =====
// Pull refreshes the list (feed + categories + the uncategorized count) and fetches the live
// balances from the bank. The pull spinner is driven by a local `pulling` flag set ONLY on a user
// pull, not by the query's raw `isFetching`. Holding the live balance call keeps a pull in flight.
describe('Transactions — pull-to-refresh (WHIT-363)', () => {
it('pull-to-refresh refreshes the visible list AND the live balances — not the Retry re-read', async () => {
  seedFeedPage(server, FEED, [ROW]);
  await draw();
  const before = { feed: gets(FEED), categories: gets(CATEGORIES), count: gets(COUNT), balances: gets(BALANCES) };
  const held = server.hold(REFRESH);
  await pull();
  await waitFor(() => expect(gets(FEED)).toBe(before.feed + 1));
  expect(gets(CATEGORIES)).toBe(before.categories + 1);
  await waitFor(() => expect(gets(COUNT)).toBe(before.count + 1));
  expect(server.sent('POST', REFRESH)).toHaveLength(1); // the LIVE bank call
  expect(gets(BALANCES)).toBe(before.balances);         // Retry's cheap stored re-read is NOT the pull
  held.release();
  await waitFor(() => expect(isSpinning()).toBe(false));
});

// [A6] ABU-106: the pull asks the bank for new transactions first and only re-reads the list once
// that answers, so a transaction the bank delivered during the sync shows when the pull ends.
it('[A6] a pull asks the bank for new transactions, then shows one that arrived during the sync', async () => {
  seedFeedPage(server, FEED, [ROW]);
  await draw();
  const feedBefore = gets(FEED);
  const bankSync = server.hold('/transactions/sync');
  await pull();
  expect(server.sent('POST', '/transactions/sync')).toHaveLength(1);
  seedFeedPage(server, FEED, [{ ...ROW, transaction_id: 't2', description: 'ALDI', merchant_name: 'Aldi', amount: -9 }, ROW]);
  await settle();
  expect(gets(FEED)).toBe(feedBefore); // the list waits for the sync
  bankSync.release();
  expect(await screen.findByText('Aldi')).toBeTruthy();
  await waitFor(() => expect(isSpinning()).toBe(false));
});

// A background/focus refetch runs with NO user pull. The spinner is owned by the local `pulling`
// flag (never isFetching, WHIT-363), so it stays DOWN when the user hasn't pulled.
it('a background/focus refetch (non-empty list, NO pull) does NOT raise the spinner', async () => {
  seedFeedPage(server, FEED, [ROW]);
  await draw();
  const feedBefore = gets(FEED);
  const held = server.hold(FEED);
  await refreshInAct(() => { void queryClient.refetchQueries({ queryKey: transactionsKey }); }); // not awaited: the reply is held
  await waitFor(() => expect(gets(FEED)).toBe(feedBefore + 1));
  expect(isSpinning()).toBe(false);
  held.release();
  await settle();
});
});

// ===== WHIT-363 adversarial edges (folded from transactionsPullRefreshEdges.screen.test.tsx) =====
// Companion to the pull-to-refresh block above: the pull-fetch-ERRORS path, the cold-load
// suppression, and the second-pull-after-resolve regression guard.
describe('Transactions — pull-to-refresh adversarial edges (WHIT-363)', () => {
// [E1] The pull's LIVE balance call FAILS. onRefresh catches it (toasts) and its .finally() still
// clears the spinner once the pull settles — the spinner must not stick just because the live call
// rejected, and the list keeps its rows (a balances failure never blanks it).
// Fail-on-revert: drop the `.catch`/`.finally` in onRefresh → the rejection escapes / the spinner
// never clears → RED.
it('[E1] a pull whose live balance call ERRORS still clears the spinner (and toasts)', async () => {
  seedFeedPage(server, FEED, [ROW]);
  await draw();
  const held = server.hold(REFRESH);
  await pull();
  expect(isSpinning()).toBe(true);
  held.fail('POST', { status: 502 }); // live call fails, list ok
  await waitFor(() => expect(isSpinning()).toBe(false)); // cleared, not stuck on error
  expect(mockShowToast).toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
  expect(screen.getByText('−\u2060$42.00')).toBeTruthy();
});

// [E3] A pull DURING the cold-load window (empty list still loading) must NOT double-spin with
// the inline loading spinner. The `listSource.length > 0` guard on `refreshing` enforces it.
// Fail-on-revert: drop that guard (refreshing={pulling}) → RED.
it('[E3] a pull during a cold load does NOT raise the pull spinner (inline spinner owns it)', async () => {
  const heldFeed = server.hold(FEED);
  const heldRefresh = server.hold(REFRESH);
  await render(<WithQueries><Transactions /></WithQueries>);
  expect(screen.getByTestId('transactions-loading')).toBeTruthy();
  await pull();
  expect(server.sent('POST', REFRESH)).toHaveLength(1); // the pull DID fire
  expect(isSpinning()).toBe(false);
  heldFeed.release();
  heldRefresh.release();
  await settle();
});

// [E2] After one full pull cycle (spin → clear), a SECOND pull must spin again and clear — the
// `pulling` flag must reset, not latch permanently.
it('[E2] a second pull after the first resolves still spins and clears', async () => {
  seedFeedPage(server, FEED, [ROW]);
  await draw();
  // First cycle.
  let held = server.hold(REFRESH);
  await pull();
  expect(isSpinning()).toBe(true);
  held.release();
  await waitFor(() => expect(isSpinning()).toBe(false));
  // Second cycle — a fresh pull spins and clears again (the flag reset, didn't latch).
  held = server.hold(REFRESH);
  await pull();
  expect(isSpinning()).toBe(true);
  held.release();
  await waitFor(() => expect(isSpinning()).toBe(false));
  expect(server.sent('POST', REFRESH)).toHaveLength(2);
});

// [E4] WHIT-489 divergent gate: a pull on a SETTLED EMPTY list (not loading, no rows) must NOT
// raise the pull spinner — the divergence from the Accounts tab, which DOES spin on its
// settled-empty list. Fail-on-revert: switch transactions.tsx to `refreshing={pulling && !showSpinner}`
// → a settled-empty pull reports refreshing=true → RED.
it('[E4] a pull on the SETTLED EMPTY list does NOT raise the pull spinner (length>0 gate)', async () => {
  await draw(); // settled + empty, NOT a cold load
  const feedBefore = gets(FEED);
  const held = server.hold(REFRESH);
  await pull();
  await waitFor(() => expect(gets(FEED)).toBe(feedBefore + 1)); // the pull DID fire (pulling=true)
  expect(server.sent('POST', REFRESH)).toHaveLength(1);
  expect(isSpinning()).toBe(false);                                // ...but the spinner is gated off
  held.release();
  await settle();
});
});

// ===== Search (folded from transactionsSearch.screen.test.tsx) =====
// The Transactions-tab search box: typing filters the list live, the ✕ clears it, no matches
// shows an empty state, and entering selection mode clears the search. Seeds its own
// two-category taxonomy (Groceries + Cafes & Coffee).
describe('Transactions — search', () => {
const CATS = [
  GROCERIES_TOP,
  { ...COFFEE_RECORD, color: '#E8A87C', parent: null },
];

const row = (over: Record<string, unknown>) => ({
  transaction_id: 't', date: '2026-07-01', authorized_date: '2026-07-01', description: '', merchant_name: '',
  amount: -10, account_id: 'a1', account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase',
  counts_to_budget: true, ...over,
});

const WOOLIES = row({ transaction_id: 'w', merchant_name: 'Woolworths', description: 'WOOLWORTHS', category: 'groceries', amount: -42 });
const COFFEE = row({ transaction_id: 'c', merchant_name: 'ST Ali', description: 'ST ALI', category: 'coffee', amount: -8.5 });

beforeEach(() => {
  server.seed(CATEGORIES, CATS);
  seedFeedPage(server, FEED, [WOOLIES, COFFEE]);
});

const type = (q: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), q);

it('typing filters the list to matching rows', async () => {
  await draw();
  expect(screen.getByText('−\u2060$42.00')).toBeTruthy();
  expect(screen.getByText('−\u2060$8.50')).toBeTruthy();

  await type('wool');
  expect(screen.getByText('−\u2060$42.00')).toBeTruthy();   // Woolworths matches
  expect(screen.queryByText('−\u2060$8.50')).toBeNull();    // coffee filtered out
});

// [A2] ABU-100: the search box sits in the list's header. Typing changes the rows below it, but
// the box itself must stay the same mounted input, or the keyboard drops on every letter.
it('typing keeps the same search box mounted while the rows change', async () => {
  await draw();
  const box = screen.getByPlaceholderText('Search transactions');
  for (const q of ['w', 'wo', 'woo', 'wool', 'xyz', '']) {
    await type(q);
    expect(screen.getByPlaceholderText('Search transactions')).toBe(box);
  }
  expect(screen.getByText('−⁠$8.50')).toBeTruthy();
  await settle();
});

it('the ✕ clears the search and restores the full list', async () => {
  await draw();
  await type('wool');
  expect(screen.queryByText('−\u2060$8.50')).toBeNull();

  await fireEvent.press(screen.getByLabelText('Clear search'));
  expect(screen.getByText('−\u2060$42.00')).toBeTruthy();
  expect(screen.getByText('−\u2060$8.50')).toBeTruthy();
});

it('entering selection mode clears an active search (the box hides, so no secret filter)', async () => {
  await draw();
  await type('wool');
  expect(screen.queryByText('−\u2060$8.50')).toBeNull();

  await fireEvent.press(screen.getByText('Select'));
  // The search box is gone in selection mode, and the list is back to the full set. In selection
  // mode the row body is a11y-hidden (the checkbox owns the label), so assert on the checkboxes.
  expect(screen.queryByPlaceholderText('Search transactions')).toBeNull();
  expect(screen.getByLabelText('Select Woolworths')).toBeTruthy();
  expect(screen.getByLabelText('Select ST Ali')).toBeTruthy();
});
});

// ===== WHIT-291 selection mode (folded from transactionsSelectMode.screen.test.tsx) =====
// A "Select" button swaps the rows for checkboxes; toggling rows tracks a set; the action bar's
// "Re-categorize" hands those ids to the picker (openMultiPicker) and leaves selection mode;
// "Cancel" exits.
describe('Transactions — selection mode (WHIT-291)', () => {
const row = (id: string, merchant: string) => ({
  ...ROW, transaction_id: id, description: merchant.toUpperCase(), merchant_name: merchant,
});

beforeEach(() => {
  seedFeedPage(server, FEED, [row('t1', 'Woolworths'), row('t2', 'Coles')]);
});

it('the "Select" header button shows on BOTH segments (All and Uncategorized)', async () => {
  await draw();
  expect(screen.getByText('Select')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('tab-uncategorized'));
  expect(screen.getByText('Select')).toBeTruthy();
});

it('Select enters selection mode; toggling rows updates the count; Re-categorize hands the ids to the picker', async () => {
  await draw();
  await fireEvent.press(screen.getByText('Select'));

  // Even a categorized row (Woolworths → groceries) is selectable in this mode.
  await fireEvent.press(screen.getByLabelText('Select Woolworths'));
  await fireEvent.press(screen.getByLabelText('Select Coles'));
  expect(screen.getByText('2 selected')).toBeTruthy();

  await fireEvent.press(screen.getByLabelText('Select Coles')); // untoggle one
  expect(screen.getByText('1 selected')).toBeTruthy();

  await fireEvent.press(screen.getByLabelText('Re-categorise selected transactions'));
  expect(mockOpenMultiPicker).toHaveBeenCalledWith(['t1']);
});

// ABU-100: a long list draws only its first screenful of rows, not every loaded row, and Select
// ticks still redraw each tapped row (and only those) as checked.
it('a long list draws only the first rows, and Select ticks redraw the tapped rows', async () => {
  const seeded = 200;
  seedFeedPage(server, FEED, Array.from({ length: seeded }, (_, i) => row(`t${i}`, `Shop ${i}`)));
  await draw();
  await fireEvent.press(screen.getByText('Select'));

  const boxes = screen.getAllByLabelText(/^Select Shop \d+$/);
  expect(boxes.length).toBeGreaterThan(2);
  expect(boxes.length).toBeLessThan(seeded);

  const [first, second, third] = boxes.map((box) => box.props.accessibilityLabel as string);
  await fireEvent.press(screen.getByLabelText(first));
  await fireEvent.press(screen.getByLabelText(second));
  expect(screen.getByText('2 selected')).toBeTruthy();
  expect(screen.getByLabelText(first).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByLabelText(second).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByLabelText(third).props.accessibilityState).toMatchObject({ checked: false });
});

it('Re-categorize does nothing with an empty selection (disabled)', async () => {
  await draw();
  await fireEvent.press(screen.getByText('Select'));
  await fireEvent.press(screen.getByLabelText('Re-categorise selected transactions'));
  expect(mockOpenMultiPicker).not.toHaveBeenCalled();
});

it('Cancel leaves selection mode and clears the checkboxes', async () => {
  await draw();
  await fireEvent.press(screen.getByText('Select'));
  expect(screen.getByLabelText('Select Woolworths')).toBeTruthy();

  await fireEvent.press(screen.getByText('Cancel'));
  expect(screen.queryByLabelText('Select Woolworths')).toBeNull();
  expect(screen.getByText('Select')).toBeTruthy();
});
});

// ===== WHIT-491 — Load More × search & tab-switch (QA gaps) =====
// Adversarial companion to the `Transactions — Load More` block above: the search interaction,
// the tab round-trip, and the isLoadingMore-leak on the empty state.
describe('Transactions — Load More × search & tab-switch (WHIT-491)', () => {
  const type = (q: string) => fireEvent.changeText(screen.getByPlaceholderText('Search transactions'), q);
  const uncategorized = { ...ROW, category: null };

  beforeEach(() => {
    seedFeedPage(server, FEED, [ROW], 'c1');
    seedFeedPage(server, UNCATEGORIZED_FEED, [], 'c1'); // older history exists on the Uncategorized tab too
  });

  // [A-S1] Uncategorized tab, everything filed (server count 0), a search typed that matches
  // nothing. "All caught up" still owns the empty state, the "No matches" block is suppressed,
  // and Load More stays hidden. Fail-on-revert: drop the Load More guard and it reappears here.
  it('[A-S1] uncategorized + all-filed + active search: All caught up shows, No matches suppressed, Load More hidden', async () => {
    await draw();
    await fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByText('All caught up')).toBeTruthy();
    await type('zzzzz');
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId('transactions-no-results')).toBeNull(); // not double-shown with All caught up
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();  // guard holds under an active search
  });

  // [A-S2] Uncategorized tab WITH real uncategorized rows (count > 0), search matches nothing:
  // "No matches" shows once the server has searched ALL history, and Load More is hidden — the
  // server already looked past every loaded page (WHIT-576), so there is nothing to page toward.
  it('[A-S2] uncategorized + uncategorized-rows + answered search miss: No matches shows, Load More hidden', async () => {
    jest.useFakeTimers();
    seedFeedPage(server, UNCATEGORIZED_FEED, [uncategorized], 'c1');
    server.seed(COUNT, { count: 1 });
    await draw();
    await fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();
    await type('zzzzz');
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(await screen.findByTestId('transactions-no-results')).toBeTruthy();
    expect(server.sent('GET', '/transactions/search?tab=uncategorized&q=zzzzz')).toHaveLength(1);
    expect(screen.queryByText('All caught up')).toBeNull();
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();
  });

  // [A-T1] Round-trip All -> Uncategorized -> All with more history and 0 uncategorized: Load More
  // shows on All, hides on Uncategorized (all caught up), shows again on returning to All — the
  // guard tracks the live tab, not a one-way latch.
  it('[A-T1] All -> Uncategorized -> All toggles Load More off then back on (0 uncategorized, more history)', async () => {
    await draw();
    expect(screen.getByTestId('transactions-load-more')).toBeTruthy();  // All: shown
    await fireEvent.press(screen.getByTestId('tab-uncategorized'));
    expect(await screen.findByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();  // Uncategorized empty: hidden
    await fireEvent.press(screen.getByTestId('tab-all'));
    expect(screen.getByTestId('transactions-load-more')).toBeTruthy();  // back to All: shown again
  });

  // [A-LS1] The empty-state guard beats isLoadingMore: a page is mid-load on the Uncategorized tab
  // when the server count drops to 0 (everything got filed). On the all-caught-up state NEITHER
  // the Load More button NOR its spinner leaks (the whole block is gated off before the
  // isLoadingMore branch).
  it('[A-LS1] uncategorized all-caught-up + a page mid-load: neither Load More button nor its spinner renders', async () => {
    server.seed(COUNT, { count: 1 });
    await draw();
    await fireEvent.press(screen.getByTestId('tab-uncategorized'));
    const loadMore = await screen.findByTestId('transactions-load-more');
    const held = server.hold(UNCATEGORIZED_FEED);
    server.once('GET', UNCATEGORIZED_FEED, { body: { transactions: [], nextCursor: null } });
    await fireEvent.press(loadMore);
    expect(await screen.findByTestId('transactions-load-more-spinner')).toBeTruthy();

    await refreshInAct(() => queryClient.setQueryData(uncategorizedCountKey, 0));
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByTestId('transactions-load-more')).toBeNull();
    expect(screen.queryByTestId('transactions-load-more-spinner')).toBeNull(); // no spinner leak
    held.release();
    await settle();
  });
});

describe('Transactions — a not-in-budget transfer on the Uncategorized tab (WHIT-330)', () => {
  const TRANSFER = {
    ...ROW, transaction_id: 'xfer1', description: 'INTERNAL TRANSFER', merchant_name: 'Internal Transfer', amount: -500,
    category: null, type: 'transfer', counts_to_budget: false,
  };

  beforeEach(() => {
    seedFeedPage(server, FEED, [TRANSFER]);
    seedFeedPage(server, UNCATEGORIZED_FEED, [TRANSFER]);
    server.seed(COUNT, { count: 1 }); // the server's whole-history tally counts the transfer
  });

  async function openUncategorizedTab() {
    await draw();
    await fireEvent.press(screen.getByTestId('tab-uncategorized'));
    await screen.findByText('Internal Transfer');
    expect(gets(UNCATEGORIZED_FEED)).toBe(1);
  }

  it('[A-empty] lists the transfer on the Uncategorized tab and hides the caught-up empty state', async () => {
    await openUncategorizedTab();
    expect(screen.queryByText('All caught up')).toBeNull();
    expect(screen.getByText('Internal Transfer')).toBeTruthy();
  });

  it('[A-file] selection mode on the Uncategorized tab can hand the transfer to the picker', async () => {
    await openUncategorizedTab();
    await fireEvent.press(screen.getByText('Select'));
    await fireEvent.press(screen.getByLabelText('Select Internal Transfer'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Re-categorise selected transactions'));
    expect(mockOpenMultiPicker).toHaveBeenCalledWith(['xfer1']);
  });
});
