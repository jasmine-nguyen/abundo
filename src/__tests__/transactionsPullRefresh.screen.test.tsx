// Screen test (WHIT-74 regression guard, retargeted for WHIT-190a): the Transactions
// list is now query-fed, but pull-to-refresh must STILL invoke `retryLoad` — that's the
// WHIT-74 guarantee (a successful pull reloads everything AND clears the "couldn't load"
// banner, not just the transactions). Post-migration it ALSO refetches the query, and the
// spinner binds to the query's `isFetching` (isLoading is false once data is cached, so it
// would never spin on a pull of already-loaded data). Fail-on-revert: dropping retryLoad
// from onRefresh (back to a query-only refresh) flips the first assertion.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';
import type { AppContext } from '../context';

// The list is query-fed now — mock the composite.
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

// useAppContext still supplies retryLoad (the banner-clear on pull).
let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]) };
});

import Transactions from '../../app/(tabs)/transactions';

const retryLoad = jest.fn();
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
  retryLoad.mockClear();
  refetch.mockClear();
  refetchStale.mockClear();
  mockTx = txData();
  mockState = { retryLoad, category } as unknown as AppContext;
});

it('pull-to-refresh invokes retryLoad (banner-clear) AND the query refetch', () => {
  const { UNSAFE_getByType } = render(<Transactions />);
  UNSAFE_getByType(RefreshControl).props.onRefresh();
  expect(retryLoad).toHaveBeenCalledTimes(1); // WHIT-74: reloads everything + clears the banner
  expect(refetch).toHaveBeenCalledTimes(1); // + refreshes the query-backed list
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
