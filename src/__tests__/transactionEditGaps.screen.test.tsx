// WHIT-275 — adversarial GAP tests for the note/tags editor. These cover the
// MISSING edges: a whitespace-only tag submit is a NO-OP (no empty tag persisted); the note
// now saves via an explicit Save button, so leaving the screen (unmount) DISCARDS an unsaved
// edit rather than flushing it; and Save trims surrounding whitespace. Same partial-context
// mock pattern as transactionEdit.screen.test.tsx.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

const mockEdit = jest.fn();
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ applyTransactionEdit: mockEdit, showToast: jest.fn() }) };
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
    transactions: [txn({ transaction_id: 't1', category: 'coffee', notes: 'old note', tags: ['work'] })],
    category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockEdit.mockClear();
  mockTx = txData();
});

it('does NOT commit a whitespace-only tag on submit', () => { // [A16]
  render(<TransactionDetail />);
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, '   ');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).not.toHaveBeenCalled(); // trimmed-empty tag is dropped, not persisted
});

it('does NOT commit a bare-comma tag input', () => { // [A17]
  render(<TransactionDetail />);
  // A lone "," commits an empty candidate → trimmed-empty → dropped.
  fireEvent.changeText(screen.getByTestId('tag-input'), ',');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('DISCARDS an unsaved note edit on unmount — no auto-flush', () => { // [A18]
  // Explicit-save model: typing then leaving WITHOUT tapping Save must write nothing,
  // matching the budget/goal/category form screens.
  const view = render(<TransactionDetail />);
  fireEvent.changeText(screen.getByTestId('note-input'), 'edited but not saved');
  view.unmount();                          // leaving the screen
  expect(mockEdit).not.toHaveBeenCalled();
});

it('does NOT save on unmount when the note is unchanged', () => { // [A19]
  const view = render(<TransactionDetail />);
  view.unmount();
  expect(mockEdit).not.toHaveBeenCalled(); // no spurious save on plain navigation
});

it('Save trims surrounding whitespace before persisting', () => { // [A20]
  render(<TransactionDetail />);
  fireEvent.changeText(screen.getByTestId('note-input'), '  padded note  ');
  fireEvent.press(screen.getByTestId('note-save'));
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'padded note' });
});
