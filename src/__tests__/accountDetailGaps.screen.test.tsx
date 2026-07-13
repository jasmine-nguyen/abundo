// WHIT-276 (adversarial GAPS) — the account/[id] screen after the cache-first scaffold moved
// into DetailStates. accountDetail.screen.test.tsx pins the error+retry and cache-first
// suppression; detailStates.screen.test.tsx pins the component in isolation. This file pins
// the gaps that only appear when DetailStates is wired to the REAL account screen's data:
//   [A-acct-loading]  a cold load hides the "No transactions" empty message (both match when
//                     detail is undefined) and shows the spinner instead.
//   [A-acct-both]     isLoading && isError with an empty cache stacks BOTH spinner and error
//                     through the real screen (not an either/or), content hidden.
//   [A-acct-cache]    a background refetch failure OVER cached rows keeps the LIST rendered,
//                     not just the error suppressed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';

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

function txData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [ROW], category: (_id: string | null) => undefined, balances: new Map(),
    isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => { mockTx = txData(); });

// [A-acct-loading] Cold load, empty cache: the spinner shows and the "No transactions" empty
// message (which ALSO matches when detail is undefined) MUST stay hidden. A revert that drops
// the hasCache gate would flash the empty state under every cold load.
it('while loading with nothing cached, shows the spinner and NOT the empty "No transactions" message', () => {
  mockTx = txData({ transactions: [], isLoading: true });
  render(<AccountDetail />);
  expect(screen.getByTestId('account-loading')).toBeTruthy();
  expect(screen.queryByText('No transactions')).toBeNull();
});

// [A-acct-both] Spinner and error are independent gates from two combined queries; with an
// empty cache both can be true and BOTH must render (matching the pre-refactor screen), with
// no content. Guards against a future collapse into an either/or through the real wiring.
it('with an empty cache, isLoading && isError renders BOTH the spinner and the error, no content', () => {
  mockTx = txData({ transactions: [], isLoading: true, isError: true });
  render(<AccountDetail />);
  expect(screen.getByTestId('account-loading')).toBeTruthy();
  expect(screen.getByTestId('account-error')).toBeTruthy();
  expect(screen.queryByText('No transactions')).toBeNull();
});

// [A-acct-cache] A background refetch failure OVER cached rows must keep the cached list
// rendered — not merely suppress the error. Asserts the real content (the count line) is
// still on screen while isError is true.
it('a background refetch failure over cached rows keeps the transaction list rendered', () => {
  mockTx = txData({ transactions: [ROW], isError: true });
  render(<AccountDetail />);
  expect(screen.queryByTestId('account-error')).toBeNull();
  expect(screen.getByText('1 transaction')).toBeTruthy(); // cached content still on screen
});
