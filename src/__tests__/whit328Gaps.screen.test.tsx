// WHIT-328 — adversarial GAP screen test for the DETAIL screen (a surface OTHER than the list row).
// The implementer covers the list row (TransactionRowExcluded). The card flagged that the detail
// screen still shows "Uncategorized" and its Category field stays tappable for a not-in-budget
// uncategorized charge — WHIT-287 lets ANY charge be re-filed from the detail screen, so the
// single-tap list gate does NOT apply here. This pins that behaviour.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

const mockOpenPicker = jest.fn();
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: mockOpenPicker, applyTransactionEdit: jest.fn(), showToast: jest.fn() }) };
});
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 't1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

const category = makeState({ categories: [cat()] }).category;
function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return {
    transactions: [txn({ transaction_id: 't1', category: null, counts_to_budget: false })],
    category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}
beforeEach(() => { mockOpenPicker.mockClear(); mockTx = txData(); });

// [A-detail] The detail screen for a not-in-budget uncategorized charge still labels the Category
// field "Uncategorized" and keeps it tappable — the re-file picker still opens. (Contrast the list
// row, which is now quiet + non-tappable.) Documents the intentional divergence; see critique.
it('detail screen labels the Category "Uncategorized" and re-opens the picker on tap', () => {
  render(<TransactionDetail />);
  expect(screen.getByText('Uncategorized')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Change category, currently Uncategorized'));
  expect(mockOpenPicker).toHaveBeenCalledWith('t1');
});
