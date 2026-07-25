// WHIT-308/WHIT-342 — the category drill-in screen (app/category/[id].tsx): the total card +
// grouped transaction list, the empty state, and the error paths (a hard read failure with
// nothing cached; a background refetch over cached rows stays quiet). The query composite
// (../queries) is mocked and CAPTURES the (id, cycle) it's called with, so WHIT-309 can assert
// the cycle param was clamped to {0,1} before the fetch. ../context is partially mocked (real
// selectors, a stubbed categoryTransactions for determinism). The categoryTransactions MATH is
// covered by the logic tests. Post-WHIT-342 the window is server-owned — no payCycle here.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockData: ReturnType<typeof screenData>;
let mockDetail: unknown;
let mockParams: { id: string; cycle?: string };
// The (id, cycle) the screen passed into the composite — captured so WHIT-309 can assert the
// cycle was clamped to the integer set {0,1} before it reached the fetch.
let mockCapturedCycle: number | undefined;
jest.mock('../queries', () => ({
  useCategoryTransactionsScreenData: (_id: string, cycle: number) => { mockCapturedCycle = cycle; return mockData; },
}));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openPicker: jest.fn(), category: () => undefined }),
    categoryTransactions: (_s: unknown, _id: unknown) => mockDetail,
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

function screenData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [ROW], category: (_id: string | null) => undefined,
    isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => { mockData = screenData(); mockDetail = DETAIL; mockParams = { id: 'coffee', cycle: '0' }; });

// The total-card label must reflect WHICH cycle was drilled (matching the Insights hero's
// "THIS / LAST PAY CYCLE"), not hard-code "this cycle".
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

// WHIT-309 — a stale/hand-edited ?cycle=2+ deep-link is clamped to 1, so the fetch can't request
// an older cycle. The cycle reaching the composite (→ the endpoint's ?cycle=) is what's clamped.
// Fail-on-revert: reverting the Math.min(1, …) clamp sends cycle 2 to the server.
it('clamps an out-of-range cycle down to 1 before the fetch', () => {
  mockParams = { id: 'coffee', cycle: '2' };
  render(<CategoryDetail />);
  expect(mockCapturedCycle).toBe(1);
});

// WHIT-309 — lower bound: a negative cycle clamps to 0, and the label agrees ("this cycle").
it('clamps a negative cycle up to 0 (fetch cycle 0, label "this cycle")', () => {
  mockParams = { id: 'coffee', cycle: '-1' };
  render(<CategoryDetail />);
  expect(mockCapturedCycle).toBe(0);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
});

// WHIT-309 — a fractional cycle in (0,1) floors to 0, so the fetch + label are the current cycle.
it('floors a fractional cycle (0.5) to 0', () => {
  mockParams = { id: 'coffee', cycle: '0.5' };
  render(<CategoryDetail />);
  expect(mockCapturedCycle).toBe(0);
  expect(screen.getByText('Spent this cycle')).toBeTruthy();
});

// WHIT-309 (qa gap) — non-numeric / empty / undefined ?cycle falls back to the CURRENT cycle.
// Fail-on-revert: reverting the `|| 0` sends NaN through the clamp into the fetch.
it('falls non-numeric / empty / undefined ?cycle back to the current cycle', () => {
  for (const bad of ['abc', '', undefined, '  '] as (string | undefined)[]) {
    mockParams = { id: 'coffee', cycle: bad };
    const { unmount } = render(<CategoryDetail />);
    expect(mockCapturedCycle).toBe(0);
    expect(screen.getByText('Spent this cycle')).toBeTruthy();
    unmount();
  }
});

// WHIT-309 (qa gap) — a huge finite cycle ('1e9') clamps to 1 (the upper bound holds far beyond 2).
it('clamps a huge finite cycle (1e9) down to 1', () => {
  mockParams = { id: 'coffee', cycle: '1e9' };
  render(<CategoryDetail />);
  expect(mockCapturedCycle).toBe(1);
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
