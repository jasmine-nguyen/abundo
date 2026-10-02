// WHIT-556 4b — GAP tests for the "Spread this bill" tx-screen prompt the implementer's cases miss.
// Already covered by transactionDetail.screen.test.tsx: start(prefill = category overage)/edit(no
// prefill)/rollover-hidden/excluded-hidden/refund-hidden/no-budget-hidden/not-found/overage-not-charge.
// These add: the budget is keyed by the transaction's OWN category (not "any over budget"), and a
// PENDING spend still qualifies (settled status isn't required). WHIT-686: the real screen data
// code runs over the pretend server.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { txn } from './factory';
import type { Transaction } from '../types';
import type { BudgetRollup } from '../api';

const mockApplyTransactionEdit = jest.fn();
const mockToast = jest.fn();
const mockOpenPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ applyTransactionEdit: mockApplyTransactionEdit, showToast: mockToast, openPicker: mockOpenPicker }),
  };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 't1' }),
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

// The taxonomy knows only 'coffee' — a budget on any other category has no category behind it.
const COFFEE = { id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', parent: null };

const rollup = (over: Partial<BudgetRollup> = {}): BudgetRollup => ({ target: 100, posted: 40, pending: 10, ...over });

const seedSpend = (over: Partial<Transaction> = {}) =>
  server.seed('/transactions/feed', { transactions: [txn({ transaction_id: 't1', category: 'coffee', amount: -130, ...over })], nextCursor: null });

beforeEach(() => {
  resetAuth();
  server.seed('/categories', [COFFEE]);
  mockPush.mockClear();
  mockApplyTransactionEdit.mockClear();
  mockToast.mockClear();
  mockOpenPicker.mockClear();
});

describe('spread this bill prompt — gap coverage', () => {
  // [G3] The prompt must key the budget off the transaction's OWN category. An over-budget budget
  // for a DIFFERENT category must not leak the prompt onto an unrelated (under-budget) charge.
  it('[G3] keys the budget by the transaction category — an over budget on another category is ignored', async () => {
    seedSpend(); // tx on 'coffee'
    server.seed('/budgets', {
      coffee: rollup({ target: 100, posted: 40, pending: 0 }),      // coffee: UNDER budget
      groceries: rollup({ target: 100, posted: 400, pending: 0 }),  // some OTHER cat: way over
    });
    await renderWithQueries(<TransactionDetail />);
    expect(screen.getByText('Woolworths')).toBeTruthy();
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  // [G4] A pending spend (status 'pending', amount < 0) whose category envelope is over still
  // qualifies — the gate keys off amount sign + eligibility, not posted/settled status. The prefill
  // is the category overage (posted 60 + pending 70 = 130 → over by 30), not the tapped charge.
  it('[G4] a PENDING over-budget spend still offers the prompt, prefilled with the overage', async () => {
    seedSpend({ status: 'pending' });
    server.seed('/budgets', { coffee: rollup({ target: 100, posted: 60, pending: 70 }) });
    await renderWithQueries(<TransactionDetail />);
    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(mockPush).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=30');
  });
});
