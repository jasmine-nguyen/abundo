// WHIT-287 — the transaction detail screen's Category row is tappable and re-opens the
// categorize picker (mockOpenPicker) for THIS transaction. Unlike a list row (which only offers
// the picker on an Uncategorized charge), the detail row re-files ANY transaction — already
// categorized, income-tagged, or pending. These tests keep the real selectors (so the row's
// label/accessibility come from transactionView) and stub only mockOpenPicker off the context.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

const mockOpenPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: mockOpenPicker, applyTransactionEdit: jest.fn() }) };
});

let mockId = 't1';
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

// cat() → id 'coffee', name 'Cafes & Coffee'. 'income' is a first-class bucket the
// selector renders as "Income"; a null/unknown id renders as "Uncategorized".
const category = makeState({ categories: [cat()] }).category;

function txData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean }> = {}) {
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
  mockOpenPicker.mockClear();
});

it('tapping the Category row opens the picker for this transaction', () => {
  render(<TransactionDetail />);
  // The row is a button labelled with the current category so it reads as "tap to change".
  const row = screen.getByLabelText('Change category, currently Cafes & Coffee');
  expect(row.props.accessibilityRole).toBe('button');

  fireEvent.press(row);
  expect(mockOpenPicker).toHaveBeenCalledTimes(1);
  expect(mockOpenPicker).toHaveBeenCalledWith('t1');
});

// The top-level test above already covers the already-categorized (coffee) case; these cover
// the states a LIST row would NOT make tappable — proving the detail row re-files regardless.
describe('re-categorize is offered regardless of the current category', () => {
  it('an income-tagged transaction is re-filable', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'income', amount: 2500 })] });
    render(<TransactionDetail />);
    fireEvent.press(screen.getByLabelText('Change category, currently Income'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });

  it('an uncategorized transaction is re-filable', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: null })] });
    render(<TransactionDetail />);
    fireEvent.press(screen.getByLabelText('Change category, currently Uncategorized'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });

  it('a pending transaction is re-filable', () => {
    mockTx = txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', status: 'pending' })] });
    render(<TransactionDetail />);
    fireEvent.press(screen.getByLabelText('Change category, currently Cafes & Coffee'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });
});

it('the picker targets the routed transaction id (not a hardcoded one)', () => {
  mockId = 't2';
  mockTx = txData({ transactions: [txn({ transaction_id: 't2', category: 'coffee' })] });
  render(<TransactionDetail />);
  fireEvent.press(screen.getByLabelText('Change category, currently Cafes & Coffee'));
  expect(mockOpenPicker).toHaveBeenCalledWith('t2');
});
