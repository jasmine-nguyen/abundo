// The Accounts tab, now its own bottom-bar screen (moved out of the Transactions segmented
// control). These assertions were relocated from transactionsScreenStates.screen.test.tsx:
// they render app/(tabs)/accounts directly — the cards show on mount, so there is no segment
// to press. The accounts view DERIVES from the transactions query (one card per account_id)
// and shows the live poller-fed balance per card. `../queries` is mocked so each gating branch
// is driven deterministically; `../context` keeps the real selectors with a stubbed
// useAppContext. Fail-on-revert: dropping `transactions.length === 0` from showError makes the
// "error with cached cards" case surface the error.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { C } from '../theme';

const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: 96270.59, available_balance: 96270.59, currency: 'AUD',
  as_of: '2026-07-08T09:32:02.405Z', account_type: 'checking', ...over,
});
const colorOf = (node: unknown) => (StyleSheet.flatten((node as { props: { style?: unknown } }).props.style) as { color?: string }).color;

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
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

const refetch = jest.fn();
const refetchStale = jest.fn();
const refetchList = jest.fn(() => Promise.resolve());
const refreshLiveBalances = jest.fn(() => Promise.resolve());

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};

function txData(over: Partial<{
  transactions: unknown[]; isLoading: boolean; isError: boolean; balances: Map<string, unknown>;
}> = {}) {
  return {
    transactions: [] as unknown[], category: (id: string | null) => (id === 'groceries' ? CAT : undefined),
    balances: new Map<string, unknown>(), isLoading: false, isError: false,
    refetch, refetchStale, refetchList, refreshLiveBalances, ...over,
  };
}

beforeEach(() => {
  refetch.mockClear();
  refetchStale.mockClear();
  mockPush.mockClear();
  mockShowToast.mockClear();
  mockTx = txData();
});

it('derives one card per account_id from the transactions (consistent name)', () => {
  const anz = { ...ROW, transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' };
  const up = { ...ROW, transaction_id: 't2', account_id: 'a2', account_name: 'Up Homeloan' };
  const up2 = { ...ROW, transaction_id: 't3', account_id: 'a2', account_name: 'Up Homeloan' };
  mockTx = txData({ transactions: [anz, up, up2] });
  render(<Accounts />);
  // One card per account; the Up account (2 txns) collapses to a single consistent name.
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.getAllByText('Up Homeloan')).toHaveLength(1);
});

it('tapping an account card navigates to that account\'s detail route', () => {
  mockTx = txData({ transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }] });
  render(<Accounts />);
  fireEvent.press(screen.getByText('ANZ'));
  expect(mockPush).toHaveBeenCalledWith('/account/a1');
});

it('shows the cold-load spinner (empty + loading)', () => {
  mockTx = txData({ transactions: [], isLoading: true, isError: false });
  render(<Accounts />);
  expect(screen.getByTestId('accounts-loading')).toBeTruthy();
});

it('shows the inline retry on a cold error (empty + error), and Retry calls refetch', () => {
  mockTx = txData({ transactions: [], isError: true });
  render(<Accounts />);
  expect(screen.getByTestId('accounts-error')).toBeTruthy();
  fireEvent.press(screen.getByTestId('accounts-retry'));
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('keeps its cards through a background error when txns are cached (cache-first)', () => {
  mockTx = txData({ transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }], isError: true });
  render(<Accounts />);
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('accounts-error')).toBeNull();
});

it('settled with no transactions shows the empty state', () => {
  mockTx = txData({ transactions: [] });
  render(<Accounts />);
  expect(screen.getByText('No accounts yet')).toBeTruthy();
});

it('an account card shows its live balance — green when in credit (amount >= 0)', () => {
  mockTx = txData({
    transactions: [{ ...ROW, account_id: 'a1', account_name: 'Up Spending' }],
    balances: new Map([['a1', bal({ amount: 96270.59 })]]),
  });
  render(<Accounts />);
  const label = screen.getByText('$96,270.59'); // bare, no + sign
  expect(colorOf(label)).toBe(C.good);
});

it('an account card shows a negative balance in red (money owed)', () => {
  mockTx = txData({
    transactions: [{ ...ROW, account_id: 'a1', account_name: 'Up Homeloan' }],
    balances: new Map([['a1', bal({ amount: -596642.43 })]]),
  });
  render(<Accounts />);
  const label = screen.getByText('-$596,642.43');
  expect(colorOf(label)).toBe(C.bad);
});

it('an account with no balance yet shows a dim "—" placeholder', () => {
  mockTx = txData({
    transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }],
    balances: new Map(), // not polled yet
  });
  render(<Accounts />);
  expect(screen.getByText('—')).toBeTruthy();
});
