// WHIT-272 (adversarial GAP) — the read-only transaction detail screen. The implementer's
// transactionDetail.screen.test.tsx covers render/pending/not-found/cache-first error+retry;
// the date format itself is owned by dateutil.logic.test.ts. This file adds the one screen
// gap those miss: the pure-LOADING gate (isLoading, nothing cached) must show the spinner and
// NOT the "not found" state (both match when the transaction is undefined).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

// WHIT-275: the screen's note/tags editor reads applyTransactionEdit from the context; stub
// it (real selectors kept) so these render without an AppProvider.
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

// [A-loading-gate] Genuinely loading with an EMPTY cache: showSpinner is true, so the
// "not found" branch (which also matches when transaction is undefined) MUST stay hidden.
// A revert that drops the `!showSpinner` guard on the empty state would flash "not found"
// under every cold load — this test fails if that happens.
it('while loading with nothing cached, shows the spinner and NOT the not-found state', () => {
  mockTx = txData({ transactions: [], isLoading: true });
  render(<TransactionDetail />);
  expect(screen.getByTestId('transaction-loading')).toBeTruthy();
  expect(screen.queryByText('Transaction not found')).toBeNull();
});
