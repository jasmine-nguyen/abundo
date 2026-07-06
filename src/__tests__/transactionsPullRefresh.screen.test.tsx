// Screen test (WHIT-74 → WHIT-190a → WHIT-192): the Transactions list is query-fed, and
// pull-to-refresh now refetches the VISIBLE LIST ONLY (the query). WHIT-192 dropped the old
// `retryLoad` app-wide reload from the pull — the other screens' reads each refresh on their
// own focus. The spinner binds to the query's `isFetching` (isLoading is false once data is
// cached, so it would never spin on a pull of already-loaded data). Fail-on-revert: dropping
// refetch from onRefresh flips the first assertion.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

// The list is query-fed — mock the composite. WHIT-192: transactions.tsx no longer reads the
// store, but the TransactionRow children it renders still pull openPicker off it, so stub that.
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: () => {} }) };
});

jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]) };
});

import Transactions from '../../app/(tabs)/transactions';

const refetch = jest.fn();
const refetchStale = jest.fn();

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 };
const ROW = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
};
const category = (id: string | null) => (id === 'groceries' ? CAT : undefined);

function txData(over: Partial<{ transactions: unknown[]; isFetching: boolean }> = {}) {
  return { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch, refetchStale, ...over };
}

beforeEach(() => {
  refetch.mockClear();
  refetchStale.mockClear();
  mockTx = txData();
});

it('pull-to-refresh refetches the visible list (the query), and nothing else', () => {
  const { UNSAFE_getByType } = render(<Transactions />);
  UNSAFE_getByType(RefreshControl).props.onRefresh();
  expect(refetch).toHaveBeenCalledTimes(1); // WHIT-192: refreshes the query-backed list only
});

it('the pull-to-refresh spinner spins while refreshing data we already have', () => {
  mockTx = txData({ transactions: [ROW], isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
});

it('the pull spinner does NOT spin during a cold load (empty + fetching) — the inline spinner owns it', () => {
  mockTx = txData({ transactions: [], isFetching: true });
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
});

it('the spinner is down when nothing is fetching', () => {
  mockTx = txData({ transactions: [ROW], isFetching: false });
  const { UNSAFE_getByType } = render(<Transactions />);
  expect(UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
});
