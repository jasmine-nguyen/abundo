// WHIT-212 — the account detail screen's balance hero: shows the signed live balance
// (green in credit / red owing), the credit-card "available" line ONLY when you owe yet
// have credit left, and hides it for a loan/spending account. The transactions query
// (../queries) is mocked; ../context is partially mocked (real selectors, stubbed
// useAppContext for TransactionRow); expo-router + safe-area are stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { C } from '../theme';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: jest.fn(), category: () => undefined }) };
});

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'a1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import AccountDetail from '../../app/account/[id]';

const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'PURCHASE', merchant_name: 'Shop', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
};

const bal = (over: Record<string, unknown> = {}) => ({
  account_id: 'a1', amount: -6492.26, available_balance: 8171.88, currency: 'AUD',
  as_of: '2026-07-08T09:32:37.337Z', account_type: 'unknown', ...over,
});

function txData(over: Partial<{ transactions: unknown[]; balances: Map<string, unknown>; isError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [ROW], category: (_id: string | null) => undefined, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

const colorOf = (node: unknown) => (StyleSheet.flatten((node as { props: { style?: unknown } }).props.style) as { color?: string }).color;

beforeEach(() => { mockTx = txData(); });

it('shows a negative balance in red and the credit-card "available" line (owe, but credit left)', () => {
  mockTx = txData({ balances: new Map([['a1', bal({ amount: -6492.26, available_balance: 8171.88 })]]) });
  render(<AccountDetail />);
  expect(colorOf(screen.getByText('-$6,492.26'))).toBe(C.bad);
  expect(screen.getByText('$8,172 available')).toBeTruthy(); // fmt() rounds
});

it('shows a positive balance in green and NO available line (spending account)', () => {
  mockTx = txData({ balances: new Map([['a1', bal({ amount: 96270.59, available_balance: 96270.59, account_type: 'checking' })]]) });
  render(<AccountDetail />);
  expect(colorOf(screen.getByText('$96,270.59'))).toBe(C.good);
  expect(screen.queryByText(/available/)).toBeNull();
});

it('hides the available line for a loan (you owe, but there is no credit to draw — available 0)', () => {
  mockTx = txData({ balances: new Map([['a1', bal({ amount: -596642.43, available_balance: 0, account_type: 'mortgage' })]]) });
  render(<AccountDetail />);
  expect(screen.getByText('-$596,642.43')).toBeTruthy();
  expect(screen.queryByText(/available/)).toBeNull();
});

it('renders no balance hero when the account has not been polled yet', () => {
  mockTx = txData({ balances: new Map() });
  render(<AccountDetail />);
  expect(screen.queryByTestId('account-balance')).toBeNull();
});

// WHIT-198 follow-up — the account-detail error state had no coverage. A hard read failure with
// NOTHING cached shows the inline error + an accessible Retry (routed through the shared
// RetryButton), and Retry re-issues the read. A failure OVER cached rows stays cache-first.
it('a hard read failure with nothing cached shows the inline error + an accessible Retry', () => {
  const refetch = jest.fn();
  mockTx = txData({ transactions: [], isError: true, refetch });
  render(<AccountDetail />);

  expect(screen.getByTestId('account-error')).toBeTruthy();
  const retry = screen.getByTestId('account-retry');
  expect(retry.props.accessibilityRole).toBe('button'); // shared RetryButton a11y contract
  expect(retry.props.accessibilityLabel).toBe('Retry loading this account');

  fireEvent.press(retry);
  expect(refetch).toHaveBeenCalledTimes(1);
});

it('does NOT show the error when a background refetch fails over cached rows (cache-first)', () => {
  mockTx = txData({ transactions: [ROW], isError: true }); // errored, but rows are cached
  render(<AccountDetail />);
  expect(screen.queryByTestId('account-error')).toBeNull(); // keep rendering the cached list
});
