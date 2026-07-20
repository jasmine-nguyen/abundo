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
jest.mock('../queries', () => ({ useCategoryTransactionsScreenData: () => mockData }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openPicker: jest.fn(), category: () => undefined }),
    categoryTransactions: () => mockDetail,
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
