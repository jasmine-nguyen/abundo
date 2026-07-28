// The Transactions tab "Load More" control. The feed's paging fields (hasMore / loadMore /
// isLoadingMore) come from useTransactionsScreenData; this locks the button's render states +
// tap wiring. The composite/query behaviour (append, cursor, snap-to-newest) is covered in
// transactionsFeed.screen. useTransactionsScreenData is mocked; expo-router + context stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockTx: ReturnType<typeof txData>;
const mockLoadMore = jest.fn();
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: () => {}, openMultiPicker: () => {} }) };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
const row = (id: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
});
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[]; hasMore: boolean; isLoadingMore: boolean }> = {}) {
  return {
    transactions: [row('t1')], category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    hasMore: false, loadMore: mockLoadMore, isLoadingMore: false, ...over,
  };
}

beforeEach(() => {
  mockLoadMore.mockClear();
  mockTx = txData();
});

it('shows Load More when there is more history, and tapping it pages older rows in', () => {
  mockTx = txData({ hasMore: true });
  render(<Transactions />);
  fireEvent.press(screen.getByTestId('transactions-load-more'));
  expect(mockLoadMore).toHaveBeenCalledTimes(1);
});

it('hides Load More at end-of-history (hasMore false)', () => {
  mockTx = txData({ hasMore: false });
  render(<Transactions />);
  expect(screen.queryByTestId('transactions-load-more')).toBeNull();
});

it('swaps the button for a spinner while the next page is loading', () => {
  mockTx = txData({ hasMore: true, isLoadingMore: true });
  render(<Transactions />);
  expect(screen.queryByTestId('transactions-load-more')).toBeNull(); // button hidden while loading
  expect(screen.getByTestId('transactions-load-more-spinner')).toBeTruthy();
});

it('does not show Load More on the Accounts tab', () => {
  mockTx = txData({ hasMore: true });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.queryByTestId('transactions-load-more')).toBeNull();
});
