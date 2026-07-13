// WHIT-275 — adversarial GAP tests for the note/tags editor. The implementer covers
// note-commit-on-blur, add-on-submit, add-on-comma, dup-ignored, remove-via-✕. These add
// the MISSING edges: a whitespace-only tag submit is a NO-OP (no empty tag persisted), and
// navigating away (unmount) FLUSHES an unsaved-but-changed note (and does NOT flush an
// unchanged one). Same partial-context mock pattern as transactionEdit.screen.test.tsx.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

const mockEdit = jest.fn();
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ applyTransactionEdit: mockEdit }) };
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

it('flushes a changed note when the screen unmounts (navigate away without blur)', () => { // [A18]
  const view = render(<TransactionDetail />);
  fireEvent.changeText(screen.getByTestId('note-input'), 'edited but not blurred');
  expect(mockEdit).not.toHaveBeenCalled(); // nothing saved yet
  view.unmount();                          // leaving the screen
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'edited but not blurred' });
});

it('does NOT flush on unmount when the note is unchanged', () => { // [A19]
  const view = render(<TransactionDetail />);
  view.unmount();
  expect(mockEdit).not.toHaveBeenCalled(); // no spurious save on plain navigation
});
