// WHIT-276 (adversarial GAP) — the transaction/[id] screen after the cache-first scaffold
// moved into DetailStates. transactionDetail.screen.test.tsx pins error+retry and cache-first;
// transactionDetailGaps.screen.test.tsx pins the pure-loading gate. This adds the concurrent
// loading+error state observed THROUGH the real screen (not just the isolated component):
// both queries can be loading AND errored with an empty cache, and both the spinner and error
// must render stacked while the "not found" empty message stays hidden.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ applyTransactionEdit: jest.fn() }) };
});

let mockId = 't1';
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

const category = makeState({ categories: [cat()] }).category;

function txData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean; refetch: () => void }> = {}) {
  return {
    transactions: [txn({ transaction_id: 't1', category: 'coffee' })],
    category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockId = 't1';
  mockTx = txData();
});

// [A-txn-both] Empty cache, isLoading && isError both true: through the real screen both the
// spinner and the error render stacked and the "not found" empty message stays hidden. A
// collapse to either/or, or dropping the hasCache gate, breaks this.
it('with an empty cache, isLoading && isError renders BOTH the spinner and the error, not the not-found state', () => {
  mockTx = txData({ transactions: [], isLoading: true, isError: true });
  render(<TransactionDetail />);
  expect(screen.getByTestId('transaction-loading')).toBeTruthy();
  expect(screen.getByTestId('transaction-error')).toBeTruthy();
  expect(screen.queryByText('Transaction not found')).toBeNull();
});
