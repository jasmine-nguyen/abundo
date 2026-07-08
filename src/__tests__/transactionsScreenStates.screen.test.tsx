// WHIT-190a — Transactions screen STATE GATING (gaps): the showSpinner/showError
// length===0 guards (cache-first: keep rows through a background refetch / an error)
// and the empty states. The composite (../queries) is mocked so each gating branch is
// driven deterministically; ../context is partially mocked (real selectors, stubbed
// useAppContext for TransactionRow).
// WHIT-215 — the Accounts tab now DERIVES from the transactions query (one card per
// account_id), so the cold-load spinner + error apply to it too, and an account name
// rendered from the fixture proves the derivation. Fail-on-revert: dropping
// `transactions.length === 0` from showError makes the "error with cached rows" case
// surface the error.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      retryLoad: jest.fn(),
      openPicker: jest.fn(),
      category: (id: string | null) => (id === 'groceries' ? CAT : undefined),
    }),
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

import Transactions from '../../app/(tabs)/transactions';

const refetch = jest.fn();
const refetchStale = jest.fn();

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};

function txData(over: Partial<{
  transactions: unknown[]; isLoading: boolean; isError: boolean; isFetching: boolean;
}> = {}) {
  return {
    transactions: [], category: (id: string | null) => (id === 'groceries' ? CAT : undefined),
    isLoading: false, isError: false, isFetching: false, refetch, refetchStale, ...over,
  };
}

beforeEach(() => {
  refetch.mockClear();
  refetchStale.mockClear();
  mockPush.mockClear();
  mockTx = txData();
});

it('error WITH cached rows keeps the rows and shows NO inline error (cache-first)', () => {
  mockTx = txData({ transactions: [ROW], isError: true });
  render(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});

it('a background refetch (isLoading) with cached rows does NOT blank the list', () => {
  mockTx = txData({ transactions: [ROW], isLoading: true });
  render(<Transactions />);
  expect(screen.getByText('-$42.00')).toBeTruthy();
  expect(screen.queryByTestId('transactions-loading')).toBeNull();
});

it('empty + error shows the inline retry, and Retry calls refetch', () => {
  mockTx = txData({ transactions: [], isError: true });
  render(<Transactions />);
  expect(screen.getByTestId('transactions-error')).toBeTruthy();
  fireEvent.press(screen.getByTestId('transactions-retry'));
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('empty + loading shows the spinner', () => {
  mockTx = txData({ transactions: [], isLoading: true });
  render(<Transactions />);
  expect(screen.getByTestId('transactions-loading')).toBeTruthy();
});

it('Accounts tab derives one card per account_id from the transactions (consistent name)', () => {
  const anz = { ...ROW, transaction_id: 't1', account_id: 'a1', account_name: 'ANZ' };
  const up = { ...ROW, transaction_id: 't2', account_id: 'a2', account_name: 'Up Homeloan' };
  const up2 = { ...ROW, transaction_id: 't3', account_id: 'a2', account_name: 'Up Homeloan' };
  mockTx = txData({ transactions: [anz, up, up2] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  // One card per account; the Up account (2 txns) collapses to a single consistent name.
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.getAllByText('Up Homeloan')).toHaveLength(1);
});

it('tapping an account card navigates to that account\'s detail route', () => {
  mockTx = txData({ transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  fireEvent.press(screen.getByText('ANZ'));
  expect(mockPush).toHaveBeenCalledWith('/account/a1');
});

it('Accounts tab shows the cold-load spinner (empty + loading) — it derives from the query now', () => {
  mockTx = txData({ transactions: [], isLoading: true, isError: false });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByTestId('transactions-loading')).toBeTruthy();
});

it('Accounts tab shows the inline retry on a cold error (empty + error)', () => {
  mockTx = txData({ transactions: [], isError: true });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByTestId('transactions-error')).toBeTruthy();
});

it('Accounts tab keeps its cards through a background error when txns are cached (cache-first)', () => {
  mockTx = txData({ transactions: [{ ...ROW, account_id: 'a1', account_name: 'ANZ' }], isError: true });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByText('ANZ')).toBeTruthy();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});

it('Accounts tab settled with no transactions shows the empty state', () => {
  mockTx = txData({ transactions: [] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByText('No accounts yet')).toBeTruthy();
});

it('empty Uncategorized tab (settled) shows the "All caught up" empty state', () => {
  mockTx = txData({ transactions: [] });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Uncategorized'));
  expect(screen.getByText('All caught up')).toBeTruthy();
});

it('empty All tab (settled) shows nothing: no empty state, no rows, no spinner, no error', () => {
  mockTx = txData({ transactions: [] });
  render(<Transactions />);
  expect(screen.queryByText('All caught up')).toBeNull(); // "all" has no empty state by design
  expect(screen.queryByText('-$42.00')).toBeNull();
  expect(screen.queryByTestId('transactions-loading')).toBeNull();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});
