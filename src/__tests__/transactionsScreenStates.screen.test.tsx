// WHIT-190a — Transactions screen STATE GATING (gaps): the showSpinner/showError
// length===0 guards (cache-first: keep rows through a background refetch / an error),
// the `tab !== 'accounts'` independence, and the empty states. The composite
// (../queries) is mocked so each gating branch is driven deterministically; ../context
// is partially mocked (real selectors, stubbed useAppContext for TransactionRow).
// Fail-on-revert: dropping `transactions.length === 0` from showError makes the
// "error with cached rows" case surface the error; removing a `tab !== 'accounts'`
// guard makes the accounts case show a spinner/error.
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

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]) };
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

it('Accounts tab renders account rows regardless of transactions loading AND error', () => {
  mockTx = txData({ transactions: [], isLoading: true, isError: true });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByText('Spending')).toBeTruthy(); // static account list
  expect(screen.queryByTestId('transactions-loading')).toBeNull();
  expect(screen.queryByTestId('transactions-error')).toBeNull();
});

it('Accounts tab shows the static list during a cold load — the spinner never leaks in', () => {
  // Independently locks the spinner-branch `tab !== 'accounts'` guard: isError:false so
  // showSpinner is genuinely true, yet the accounts tab must not render it.
  mockTx = txData({ transactions: [], isLoading: true, isError: false });
  render(<Transactions />);
  fireEvent.press(screen.getByText('Accounts'));
  expect(screen.getByText('Spending')).toBeTruthy();
  expect(screen.queryByTestId('transactions-loading')).toBeNull();
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
