// WHIT-215 GAP (accounts-separate-tab) — the Accounts SEGMENT was lifted out of the Transactions
// screen into its own tab. The existing tests moved the account-card ASSERTIONS to
// accountsTab.screen.test.tsx but nothing locks that the segment is truly GONE from Transactions.
// These are the regression guards: no "Accounts" segment button, no account-view artifacts
// ("No accounts yet" empty state, the "—" pending-balance placeholder) ever render on the
// Transactions screen even with account-bearing data; and the "Select" header button shows on
// BOTH remaining segments (All + Uncategorized), not tied to a tab.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ openMultiPicker: jest.fn(), showToast: jest.fn() }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useRouter: () => ({ push: jest.fn() }),
  };
});

import Transactions from '../../app/(tabs)/transactions';

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};

function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return {
    transactions: [] as unknown[], category: (id: string | null) => (id === 'groceries' ? CAT : undefined),
    balances: new Map(), isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(), refetchList: jest.fn(() => Promise.resolve()),
    refreshLiveBalances: jest.fn(() => Promise.resolve()), hasMore: false, loadMore: jest.fn(), isLoadingMore: false, ...over,
  };
}

beforeEach(() => { mockTx = txData(); });

it('renders only the "All" and "Uncategorized" segments — the "Accounts" segment is gone', () => {
  mockTx = txData({ transactions: [ROW] });
  render(<Transactions />);
  expect(screen.getByText('All')).toBeTruthy();
  expect(screen.getByText('Uncategorized')).toBeTruthy();
  expect(screen.queryByText('Accounts')).toBeNull(); // the segment was moved to its own tab
});

it('never shows the accounts-view artifacts, even with account-bearing transactions', () => {
  // A single account's charges. On the old segment this drove an account CARD + balance; on the
  // Transactions screen there must be no card, no empty state, no pending "—" placeholder.
  mockTx = txData({ transactions: [ROW] });
  render(<Transactions />);
  expect(screen.queryByText('No accounts yet')).toBeNull();
  expect(screen.queryByText('—')).toBeNull();            // the account pending-balance placeholder
  expect(screen.queryByText('1 transaction')).toBeNull(); // the account card's txn-count subtitle
});

it('an empty transactions list on Transactions shows NO "No accounts yet" (that is the Accounts tab\'s state)', () => {
  mockTx = txData({ transactions: [] });
  render(<Transactions />);
  expect(screen.queryByText('No accounts yet')).toBeNull();
});

it('the "Select" header button shows on BOTH remaining segments (All and Uncategorized)', () => {
  mockTx = txData({ transactions: [ROW] });
  render(<Transactions />);
  expect(screen.getByText('Select')).toBeTruthy();      // visible on the default "All" segment
  fireEvent.press(screen.getByText('Uncategorized'));
  expect(screen.getByText('Select')).toBeTruthy();      // still visible after switching segment
});
