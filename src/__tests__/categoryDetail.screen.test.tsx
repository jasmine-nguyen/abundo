// WHIT-308 — the category drill-in screen (app/category/[id].tsx): the total card + grouped
// transaction list, the empty state, and the two error paths (a hard read failure with nothing
// cached, and a first-load pay-cycle failure whose window can't be trusted). The query composite
// (../queries) is mocked; ../context is PARTIALLY mocked (real selectors, a stubbed
// categoryTransactions for determinism + a stubbed useAppContext for TransactionRow); expo-router
// + safe-area are stubbed. The cycleWindow/categoryTransactions MATH is covered by the logic tests.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockData: ReturnType<typeof screenData>;
let mockDetail: unknown;
let mockParams: { id: string; cycle?: string };
// The window the screen passed into categoryTransactions — captured so WHIT-309 can assert the
// cycle param was clamped BEFORE it reached the (real) cycleWindow. cycleWindow stays real
// (`...actual`), so a different clamped cycle yields a genuinely different window here.
let mockCapturedWindow: unknown;
jest.mock('../queries', () => ({ useCategoryTransactionsScreenData: () => mockData }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openPicker: jest.fn(), category: () => undefined }),
    categoryTransactions: (_s: unknown, _id: unknown, window: unknown) => { mockCapturedWindow = window; return mockDetail; },
  };
});

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import CategoryDetail from '../../app/category/[id]';

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'ST ALi', merchant_name: 'ST Ali', amount: -8.5, account_id: 'a1',
  account_name: 'Everyday', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};

const DETAIL = {
  id: 'coffee', name: 'Cafes & Coffee',
  groups: [{ label: 'Jul 1', items: [ROW] }],
  count: 1, total: 8.5, posted: 8.5, pending: 0,
};

function screenData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean; payCycleError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [ROW], category: (_id: string | null) => undefined,
    payCycle: { length: 14, last_pay_date: '2026-06-06' },
    isLoading: false, isError: false, payCycleError: false, refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => { mockData = screenData(); mockDetail = DETAIL; mockParams = { id: 'coffee', cycle: '0' }; });

// The total-card label must reflect WHICH cycle was drilled (matching the Insights hero's
// "THIS / LAST PAY CYCLE"), not hard-code "this cycle" — otherwise a Last-cycle drill lies
// about the window its number covers.
it('labels the total "this cycle" for cycle 0 and "last cycle" for cycle 1', () => {
  mockParams = { id: 'coffee', cycle: '0' };
  const { unmount } = render(<CategoryDetail />);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
  expect(screen.queryByText('Spent last cycle')).toBeNull();
  unmount();

  mockParams = { id: 'coffee', cycle: '1' };
  render(<CategoryDetail />);
  expect(screen.getByText('Spent last cycle')).toBeTruthy();
  expect(screen.queryByText('Spent this cycle')).toBeNull();
});

// WHIT-309 — a stale/hand-edited ?cycle=2+ deep-link is clamped to 1, so it can't render an
// older pay cycle's window. Upper-bound fail-on-revert: the window the screen builds for cycle
// '2' must equal the window it builds for cycle '1' (both go through the REAL cycleWindow with a
// clamped cycleNum). Relative comparison, so it's deterministic regardless of "today".
it('clamps an out-of-range cycle down to 1 (same window as last cycle)', () => {
  mockParams = { id: 'coffee', cycle: '1' };
  const { unmount } = render(<CategoryDetail />);
  const lastCycleWindow = mockCapturedWindow;
  unmount();

  mockParams = { id: 'coffee', cycle: '2' };
  render(<CategoryDetail />);
  expect(mockCapturedWindow).toEqual(lastCycleWindow); // reverting the clamp → 2nd-prior window ≠ last
});

// WHIT-309 — lower bound: a negative cycle is clamped to 0, so the window is the current cycle
// AND the label agrees ("this cycle"). Without the clamp, cycleNum = -1 is non-zero, so the label
// would read "last cycle" over a current-cycle window — the mismatch the clamp closes.
it('clamps a negative cycle up to 0 (label reads "this cycle")', () => {
  mockParams = { id: 'coffee', cycle: '-1' };
  render(<CategoryDetail />);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
  expect(screen.queryByText('Spent last cycle')).toBeNull();
});

// WHIT-309 — a fractional cycle in (0,1) floors to 0, so it shows the CURRENT window AND the
// label agrees. Without Math.floor, 0.5 survives the clamp; it hits cycleWindow's cycle<1 branch
// (current window) but `cycleNum === 0` is false → the label would wrongly read "last cycle".
it('floors a fractional cycle (0.5) to 0 (current window, label "this cycle")', () => {
  mockParams = { id: 'coffee', cycle: '0' };
  const { unmount } = render(<CategoryDetail />);
  const currentWindow = mockCapturedWindow;
  unmount();

  mockParams = { id: 'coffee', cycle: '0.5' };
  render(<CategoryDetail />);
  expect(mockCapturedWindow).toEqual(currentWindow);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
  expect(screen.queryByText('Spent last cycle')).toBeNull();
});

// WHIT-309 (qa gap) — non-numeric / empty / undefined ?cycle falls back to the CURRENT cycle.
// The `|| 0` fallback is load-bearing under the clamp: a bare NaN would flow through Math.floor/
// max/min unchanged into cycleWindow's prior-cycle branch (a garbage window) and mislabel "last".
it('falls non-numeric / empty / undefined ?cycle back to the current cycle (window + label)', () => {
  mockParams = { id: 'coffee', cycle: '0' };
  const { unmount } = render(<CategoryDetail />);
  const currentWindow = mockCapturedWindow;
  unmount();

  for (const bad of ['abc', '', undefined, '  '] as (string | undefined)[]) {
    mockParams = { id: 'coffee', cycle: bad };
    const { unmount: u } = render(<CategoryDetail />);
    expect(mockCapturedWindow).toEqual(currentWindow); // revert `|| 0` → NaN → prior/garbage window ≠ this
    expect(screen.getByText('Spent this cycle')).toBeTruthy();
    expect(screen.queryByText('Spent last cycle')).toBeNull();
    u();
  }
});

// WHIT-309 (qa gap) — a huge finite cycle ('1e9') clamps to the SAME window as cycle '1' (the
// upper bound holds far beyond the 2→1 case).
it('clamps a huge finite cycle (1e9) to the last-cycle window', () => {
  mockParams = { id: 'coffee', cycle: '1' };
  const { unmount } = render(<CategoryDetail />);
  const lastWindow = mockCapturedWindow;
  unmount();

  mockParams = { id: 'coffee', cycle: '1e9' };
  render(<CategoryDetail />);
  expect(mockCapturedWindow).toEqual(lastWindow);
  expect(screen.getByText('Spent last cycle')).toBeTruthy();
});

it('renders the category name, the total card, and the grouped transactions', () => {
  render(<CategoryDetail />);
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();      // header
  expect(screen.getByTestId('category-total')).toBeTruthy();
  expect(screen.getByText('$9')).toBeTruthy();                   // fmt(8.5) rounds
  expect(screen.getByText('1 transaction')).toBeTruthy();
  expect(screen.getByText('Jul 1')).toBeTruthy();               // date group
  expect(screen.getByText('ST Ali')).toBeTruthy();              // the row
});

it('shows the pending line only when there is pending spend', () => {
  mockDetail = { ...DETAIL, total: 20, posted: 12, pending: 8 };
  render(<CategoryDetail />);
  expect(screen.getByText('$8 pending')).toBeTruthy();
});

it('shows the empty state when nothing matches this category/cycle (detail is null)', () => {
  mockDetail = null;
  render(<CategoryDetail />);
  expect(screen.getByText('No transactions')).toBeTruthy();
  expect(screen.queryByTestId('category-total')).toBeNull();
});

it('a hard read failure with nothing cached shows the inline error + an accessible Retry', () => {
  const refetch = jest.fn();
  mockData = screenData({ transactions: [], isError: true, refetch });
  render(<CategoryDetail />);
  expect(screen.getByTestId('category-error')).toBeTruthy();
  const retry = screen.getByTestId('category-retry');
  expect(retry.props.accessibilityLabel).toBe('Retry loading this category');
  fireEvent.press(retry);
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('does NOT show the error when a background refetch fails over cached rows (cache-first)', () => {
  mockData = screenData({ transactions: [ROW], isError: true });
  render(<CategoryDetail />);
  expect(screen.queryByTestId('category-error')).toBeNull();
});

// A first-load pay-cycle failure makes the window untrustworthy → force the error card even
// though the transaction list itself is cached (the drilled dates would otherwise be wrong).
it('forces the error state on a first-load pay-cycle failure, even with cached transactions', () => {
  mockData = screenData({ transactions: [ROW], payCycleError: true });
  render(<CategoryDetail />);
  expect(screen.getByTestId('category-error')).toBeTruthy();
  expect(screen.queryByTestId('category-total')).toBeNull();
});
