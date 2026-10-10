// WHIT-308/WHIT-342 — the category drill-in screen (app/category/[id].tsx): the total card +
// grouped transaction list, the empty state, and the error paths (a hard read failure with
// nothing cached; a background refetch over cached rows stays quiet). Real query hooks and the
// real categoryTransactions selector over the fake server (WHIT-688), so the total and groups
// come from seeded rows, and the request log shows the cycle / date range the screen asked for
// (WHIT-309's clamp). ../context is partially mocked only for the rows' useAppContext.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, WithQueries } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ openPicker: jest.fn(), category: () => undefined })),
);

import CategoryDetail from '../../app/category/[id]';
import { COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const COFFEE_ROWS = '/categories/coffee/transactions';

const CATEGORIES = [
  COFFEE_RECORD,
  { id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase' },
];

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'ST ALi', merchant_name: 'ST Ali', amount: -8.5, account_id: 'a1',
  account_name: 'Everyday', category: 'coffee', status: 'posted', type: 'purchase', counts_to_budget: true,
};

const SALARY_ROW = {
  ...ROW, transaction_id: 's1', description: 'Payroll', merchant_name: 'Payroll', amount: 4200,
  category: 'salary', type: 'deposit', counts_to_budget: true,
};

beforeEach(() => {
  resetAuth();
  resetRouter();
  setParams({ id: 'coffee', cycle: '0' });
  server.seed('/categories', CATEGORIES);
  server.seed(COFFEE_ROWS, [ROW]);
});

// The total-card label must reflect WHICH cycle was drilled (matching the Insights hero's
// "THIS / LAST PAY CYCLE"), not hard-code "this cycle".
it('labels the total "this cycle" for cycle 0 and "last cycle" for cycle 1', async () => {
  const { unmount } = await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
  expect(screen.queryByText('Spent last cycle')).toBeNull();
  unmount();

  setParams({ id: 'coffee', cycle: '1' });
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('Spent last cycle')).toBeTruthy();
  expect(screen.queryByText('Spent this cycle')).toBeNull();
});

// WHIT-366 — an Income-bucket category reached from the Earned drill reads "Earned", not "Spent".
it('labels the total "Earned" for an Income-bucket category', async () => {
  server.seed('/categories/salary/transactions', [SALARY_ROW]);
  setParams({ id: 'salary', cycle: '0' });
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('Earned this cycle')).toBeTruthy();
  expect(screen.queryByText('Spent this cycle')).toBeNull();
  expect(screen.getByText('$4,200')).toBeTruthy();
});

// WHIT-374 — the cold-taxonomy gate. Transactions are in but the category list is still loading:
// the screen shows the spinner, not a cold "Spent $0". FAIL-ON-REVERT: dropping
// `&& categoriesReady` from hasCache lets the detail render here.
it('waits for the category taxonomy before rendering the detail (spinner, not a cold "$0")', async () => {
  const held = server.hold('/categories');
  render(<WithQueries><CategoryDetail /></WithQueries>);
  await waitFor(() => expect(queryClient.isFetching()).toBe(1)); // rows in, categories in flight
  expect(screen.getByTestId('category-loading')).toBeTruthy();
  expect(screen.queryByTestId('category-total')).toBeNull();

  await refreshInAct(() => held.release());
  await waitFor(() => expect(screen.getByTestId('category-total')).toBeTruthy());
});

// WHIT-374 regression — once categories are loaded, a background refetch over cached rows keeps
// the detail visible, no spinner.
it('keeps the detail visible during a background refetch once the taxonomy is loaded', async () => {
  await renderWithQueries(<CategoryDetail />);
  const held = server.hold(COFFEE_ROWS);
  await refreshInAct(() => { void queryClient.refetchQueries(); });
  expect(queryClient.isFetching()).toBeGreaterThan(0);
  expect(screen.queryByTestId('category-loading')).toBeNull();
  expect(screen.getByTestId('category-total')).toBeTruthy();
  await refreshInAct(() => held.release());
});

// WHIT-309 — ?cycle= is clamped to 0..1 (floored; non-numeric → the current cycle) before the
// fetch, so a stale/hand-edited deep link can't request an older cycle or send NaN.
it.each([
  ['2', `${COFFEE_ROWS}?cycle=1`, 'Spent last cycle'],
  ['1e9', `${COFFEE_ROWS}?cycle=1`, 'Spent last cycle'],
  ['-1', COFFEE_ROWS, 'Spent this cycle'],
  ['0.5', COFFEE_ROWS, 'Spent this cycle'],
  ['abc', COFFEE_ROWS, 'Spent this cycle'],
  ['', COFFEE_ROWS, 'Spent this cycle'],
  [undefined, COFFEE_ROWS, 'Spent this cycle'],
  ['  ', COFFEE_ROWS, 'Spent this cycle'],
])('?cycle=%j fetches %s', async (cycle, path, label) => {
  setParams({ id: 'coffee', cycle });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sentUnder('GET', COFFEE_ROWS).map((request) => request.path)).toEqual([path]);
  expect(screen.getByText(label)).toBeTruthy();
});

it('renders the category name, the total card, and the grouped transactions', async () => {
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getAllByText('Cafes & Coffee')).toHaveLength(2); // header + the row's category
  expect(screen.getByTestId('category-total')).toBeTruthy();
  expect(screen.getByText('$9')).toBeTruthy();                   // 8.5 rounds
  expect(screen.getByText('1 transaction')).toBeTruthy();
  expect(screen.getByText('Wed 1 Jul')).toBeTruthy();           // date group
  expect(screen.getByText('ST Ali')).toBeTruthy();              // the row
});

it('shows the pending line only when there is pending spend', async () => {
  server.seed(COFFEE_ROWS, [
    { ...ROW, amount: -12 },
    { ...ROW, transaction_id: 't2', amount: -8, status: 'pending' },
  ]);
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('$20')).toBeTruthy();
  expect(screen.getByText('$8 pending')).toBeTruthy();
});

it('shows the empty state when nothing matches this category/cycle', async () => {
  server.seed(COFFEE_ROWS, []);
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('No transactions')).toBeTruthy();
  expect(screen.getByText('Nothing in this category for the selected cycle.')).toBeTruthy();
  expect(screen.queryByTestId('category-total')).toBeNull();
});

it('does NOT show the error when a background refetch fails over cached rows (cache-first)', async () => {
  await renderWithQueries(<CategoryDetail />);
  server.fail(COFFEE_ROWS, 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(server.sent('GET', COFFEE_ROWS)).toHaveLength(2);
  expect(screen.queryByTestId('category-error')).toBeNull();
  expect(screen.getByTestId('category-total')).toBeTruthy();
});

// WHIT-688 — drill-in edges over the real query hooks.
// [A1] (P0) The "?" bucket drill reads its own endpoint and titles itself "Uncategorized".
it('the Uncategorized drill asks for the sentinel id and titles the screen "Uncategorized"', async () => {
  setParams({ id: '__uncategorized__', cycle: '0' });
  server.seed('/categories/__uncategorized__/transactions', [{ ...ROW, category: null, amount: -20 }]);
  await renderWithQueries(<CategoryDetail />);
  expect(server.sent('GET', '/categories/__uncategorized__/transactions')).toHaveLength(1);
  expect(screen.getAllByText('Uncategorized')).toHaveLength(2); // the header + the row's label
  expect(screen.getByText('$20')).toBeTruthy();
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
});

// [A2] (P0) Retry after a hard read failure actually recovers: the detail replaces the error.
it('Retry after a failed first read shows the detail once the server answers', async () => {
  server.once('GET', COFFEE_ROWS, { status: 500 });
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByTestId('category-error')).toBeTruthy();
  expect(screen.getByTestId('category-retry').props.accessibilityLabel).toBe('Retry loading this category');

  fireEvent.press(screen.getByTestId('category-retry'));
  await waitFor(() => expect(screen.getByTestId('category-total')).toBeTruthy());
  expect(screen.queryByTestId('category-error')).toBeNull();
  expect(screen.getByText('$9')).toBeTruthy();
});

// [A3] (P0) Retry after the taxonomy failed re-reads /categories and the detail then renders.
it('Retry after the category list failed shows the detail once the list loads', async () => {
  server.once('GET', '/categories', { status: 500 });
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByTestId('category-error')).toBeTruthy();
  expect(screen.queryByTestId('category-total')).toBeNull(); // WHIT-374: no cold "$0" total card

  fireEvent.press(screen.getByTestId('category-retry'));
  await waitFor(() => expect(screen.getByTestId('category-total')).toBeTruthy());
  expect(screen.getAllByText('Cafes & Coffee').length).toBeGreaterThan(0);
});

// [A5] (P0) Moving from this cycle to last cycle re-reads with ?cycle=1 and shows last cycle's
// rows, not this cycle's cached ones. Fail-on-revert: drop `cycle` from the query key and the
// cached cycle-0 rows answer for cycle 1.
it('switching to last cycle re-reads ?cycle=1 and shows that cycle\'s total, not the cached one', async () => {
  const view = await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('$9')).toBeTruthy();

  server.once('GET', COFFEE_ROWS, { status: 200, body: [{ ...ROW, transaction_id: 't9', amount: -42 }] });
  setParams({ id: 'coffee', cycle: '1' });
  view.rerender(<WithQueries><CategoryDetail /></WithQueries>);
  await waitFor(() => expect(screen.getByText('$42')).toBeTruthy());
  expect(server.sent('GET', `${COFFEE_ROWS}?cycle=1`)).toHaveLength(1);
  expect(screen.getByText('Spent last cycle')).toBeTruthy();
  expect(screen.queryByText('$9')).toBeNull();
});

// [A6] (P1) A row filed under a category the taxonomy doesn't know still counts and lists.
it('counts a row whose category is missing from the list (no crash, row listed)', async () => {
  server.seed(COFFEE_ROWS, [ROW, { ...ROW, transaction_id: 't2', amount: -1.5, category: 'gone', merchant_name: 'Ghost' }]);
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('$10')).toBeTruthy();
  expect(screen.getByText('2 transactions')).toBeTruthy();
  expect(screen.getByText('Ghost')).toBeTruthy();
});

// ===== Card 609 — the Ask Abundo deep link: ?from=&to= instead of ?cycle= =====

// The header drops the year only for a range inside the CURRENT year, so these dates follow the
// real clock — fixed 2026 dates would start showing "2026" (and fail) on 1 Jan 2027.
const THIS_YEAR = new Date().getFullYear();
const JUN_12 = `${THIS_YEAR}-06-12`;
const SEP_11 = `${THIS_YEAR}-09-11`;

it('a from/to pair fetches that date range and labels the total with the dates', async () => {
  setParams({ id: 'coffee', from: JUN_12, to: SEP_11 });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sentUnder('GET', COFFEE_ROWS).map((request) => request.path)).toEqual([
    `${COFFEE_ROWS}?from=${JUN_12}&to=${SEP_11}`,
  ]);
  expect(screen.getByText('Spent 12 Jun – 11 Sep')).toBeTruthy();
  expect(screen.queryByText('Spent this cycle')).toBeNull();
});

it.each([
  [{ from: '2026-06-12' }, `${COFFEE_ROWS}?cycle=1`, 'Spent last cycle'],                              // only one end
  [{ from: '2026-6-12', to: '2026-09-11' }, `${COFFEE_ROWS}?cycle=1`, 'Spent last cycle'],             // not YYYY-MM-DD
  [{ from: '2026-09-11', to: '2026-06-12' }, `${COFFEE_ROWS}?cycle=1`, 'Spent last cycle'],            // out of order
  [{ from: SEP_11, to: SEP_11 }, `${COFFEE_ROWS}?from=${SEP_11}&to=${SEP_11}`, 'Spent 11 Sep – 11 Sep'], // one day is valid
])('a range %j fetches %s (a bad one falls back to the cycle view)', async (range, path, label) => {
  setParams({ id: 'coffee', cycle: '1', ...range });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sentUnder('GET', COFFEE_ROWS).map((request) => request.path)).toEqual([path]);
  expect(screen.getByText(label)).toBeTruthy();
});

// [A23] QA: a valid range wins over a leftover ?cycle= — the dates the chat answered for are
// what the screen fetches and labels.
it('a valid range with a leftover cycle=1 still shows the range, not last cycle', async () => {
  setParams({ id: 'coffee', cycle: '1', from: JUN_12, to: SEP_11 });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sentUnder('GET', COFFEE_ROWS).map((request) => request.path)).toEqual([
    `${COFFEE_ROWS}?from=${JUN_12}&to=${SEP_11}`,
  ]);
  expect(screen.getByText('Spent 12 Jun – 11 Sep')).toBeTruthy();
  expect(screen.queryByText('Spent last cycle')).toBeNull();
});
