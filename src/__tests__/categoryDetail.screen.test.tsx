// WHIT-308/WHIT-342 — the category drill-in screen (app/category/[id].tsx): the total card +
// grouped transaction list, the empty state, and the error paths (a hard read failure with
// nothing cached; a background refetch over cached rows stays quiet). Real query hooks and the
// real categoryTransactions selector over the fake server (WHIT-688), so the total and groups
// come from seeded rows, and the request log shows the cycle / date range the screen asked for
// (WHIT-309's clamp). ../context is partially mocked only for the rows' useAppContext.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, WithQueries, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { setParams, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), category: () => undefined }) };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import CategoryDetail from '../../app/category/[id]';

const server = installFakeServer();
useTestQueryClient();

const COFFEE_ROWS = '/categories/coffee/transactions';

const CATEGORIES = [
  { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee' },
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

// WHIT-309 — a stale/hand-edited ?cycle=2+ deep-link is clamped to 1, so the fetch can't request
// an older cycle. Fail-on-revert: reverting the Math.min(1, …) clamp sends cycle 2 to the server.
it('clamps an out-of-range cycle down to 1 before the fetch', async () => {
  setParams({ id: 'coffee', cycle: '2' });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sent('GET', `${COFFEE_ROWS}?cycle=1`)).toHaveLength(1);
  expect(server.sentUnder('GET', COFFEE_ROWS)).toHaveLength(1);
});

// WHIT-309 — lower bound: a negative cycle clamps to 0, and the label agrees ("this cycle").
it('clamps a negative cycle up to 0 (fetch cycle 0, label "this cycle")', async () => {
  setParams({ id: 'coffee', cycle: '-1' });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sent('GET', COFFEE_ROWS)).toHaveLength(1);
  expect(server.sentUnder('GET', COFFEE_ROWS)).toHaveLength(1);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
});

// WHIT-309 — a fractional cycle in (0,1) floors to 0, so the fetch + label are the current cycle.
it('floors a fractional cycle (0.5) to 0', async () => {
  setParams({ id: 'coffee', cycle: '0.5' });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sent('GET', COFFEE_ROWS)).toHaveLength(1);
  expect(server.sentUnder('GET', COFFEE_ROWS)).toHaveLength(1);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
});

// WHIT-309 (qa gap) — non-numeric / empty / undefined ?cycle falls back to the CURRENT cycle.
// Fail-on-revert: reverting the `|| 0` sends NaN through the clamp into the fetch.
it.each(['abc', '', undefined, '  '])('falls ?cycle=%j back to the current cycle', async (bad) => {
  setParams({ id: 'coffee', cycle: bad });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sent('GET', COFFEE_ROWS)).toHaveLength(1);
  expect(server.sentUnder('GET', COFFEE_ROWS)).toHaveLength(1);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
});

// WHIT-309 (qa gap) — a huge finite cycle ('1e9') clamps to 1 (the upper bound holds far beyond 2).
it('clamps a huge finite cycle (1e9) down to 1', async () => {
  setParams({ id: 'coffee', cycle: '1e9' });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sent('GET', `${COFFEE_ROWS}?cycle=1`)).toHaveLength(1);
  expect(server.sentUnder('GET', COFFEE_ROWS)).toHaveLength(1);
  expect(screen.getByText('Spent last cycle')).toBeTruthy();
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
  expect(screen.queryByTestId('category-total')).toBeNull();
});

it('a hard read failure with nothing cached shows the inline error + an accessible Retry', async () => {
  server.fail(COFFEE_ROWS, 500);
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByTestId('category-error')).toBeTruthy();
  const retry = screen.getByTestId('category-retry');
  expect(retry.props.accessibilityLabel).toBe('Retry loading this category');
  fireEvent.press(retry);
  await waitFor(() => expect(server.sent('GET', COFFEE_ROWS)).toHaveLength(2));
  await settle();
});

it('does NOT show the error when a background refetch fails over cached rows (cache-first)', async () => {
  await renderWithQueries(<CategoryDetail />);
  server.fail(COFFEE_ROWS, 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(server.sent('GET', COFFEE_ROWS)).toHaveLength(2);
  expect(screen.queryByTestId('category-error')).toBeNull();
  expect(screen.getByTestId('category-total')).toBeTruthy();
});

// WHIT-308 adversarial gaps — the header-title fallback and the non-null $0 detail path, both
// distinct from the empty state above.
// [A-S1] Nothing for this cycle (or a stale deep-link) → the header still reads a sensible title.
// Fail-on-revert: dropping the `?? 'Category'` fallback makes the title `undefined`.
it('shows the fallback header title "Category" when there are no rows', async () => {
  server.seed(COFFEE_ROWS, []);
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByText('Category')).toBeTruthy();
});

// [A-S2] Rows whose total comes to 0 (none counts to the budget) still render the total card +
// list, NOT the empty state — the screen branches on having a detail, not on total > 0.
it('renders the $0 total card and list (not the empty state) for a zero-total detail', async () => {
  server.seed(COFFEE_ROWS, [{ ...ROW, counts_to_budget: false }]);
  await renderWithQueries(<CategoryDetail />);
  expect(screen.getByTestId('category-total')).toBeTruthy();
  expect(screen.getByText('$0')).toBeTruthy();
  expect(screen.getByText('ST Ali')).toBeTruthy();
  expect(screen.queryByText('No transactions')).toBeNull();
});

// ===== WHIT-374 — the taxonomy fails over cached transactions =====
describe('WHIT-374 gap — cold taxonomy over cached transactions', () => {
  beforeEach(() => {
    server.seed('/categories/salary/transactions', [SALARY_ROW]);
    setParams({ id: 'salary', cycle: '0' });
  });

  // [A-CE1] (P0) — the category list failed but the rows loaded. The error card (the detail needs
  // the taxonomy to label and sign rows) wins over a cold detail. FAIL-ON-REVERT: dropping
  // `&& categoriesReady` from hasCache makes the cold detail render and this assertion fail.
  it('shows the error+retry (not a cold detail) when the taxonomy fails over cached transactions', async () => {
    server.fail('/categories', 500);
    await renderWithQueries(<CategoryDetail />);
    expect(screen.getByTestId('category-error')).toBeTruthy();
    expect(screen.queryByTestId('category-total')).toBeNull(); // no cold "$0" total card
    fireEvent.press(screen.getByTestId('category-retry'));
    await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(2));
    await settle();
  });
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
  [{ from: '2026-06-12' }],                                 // only one end
  [{ from: '2026-6-12', to: '2026-09-11' }],                // not YYYY-MM-DD
  [{ from: '2026-09-11', to: '2026-06-12' }],               // out of order
])('a bad range falls back to the cycle view (%j)', async (range) => {
  setParams({ id: 'coffee', cycle: '1', ...range });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sentUnder('GET', COFFEE_ROWS).map((request) => request.path)).toEqual([`${COFFEE_ROWS}?cycle=1`]);
  expect(screen.getByText('Spent last cycle')).toBeTruthy();
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

// [A23] QA: a same-day range (from === to) is valid, not "out of order".
it('a one-day range is accepted', async () => {
  setParams({ id: 'coffee', from: '2026-09-11', to: '2026-09-11' });
  await renderWithQueries(<CategoryDetail />);
  expect(server.sentUnder('GET', COFFEE_ROWS).map((request) => request.path)).toEqual([
    `${COFFEE_ROWS}?from=2026-09-11&to=2026-09-11`,
  ]);
});
