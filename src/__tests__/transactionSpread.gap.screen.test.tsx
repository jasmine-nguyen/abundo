// WHIT-556 4b — GAP tests for the "Spread this bill" tx-screen prompt the implementer's cases miss.
// Already covered by transactionDetail.screen.test.tsx: start(prefill = category overage)/edit(no
// prefill)/rollover-hidden/excluded-hidden/refund-hidden/no-budget-hidden/not-found/overage-not-charge.
// This adds: the budget is keyed by the transaction's OWN category (not "any over budget").
// WHIT-686: the real screen data code runs over the pretend server.
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { txn } from './factory';
import type { Transaction } from '../types';
import type { BudgetRollup } from '../api';

const mockApplyTransactionEdit = jest.fn();
const mockToast = jest.fn();
const mockOpenPicker = jest.fn();
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ applyTransactionEdit: mockApplyTransactionEdit, showToast: mockToast, openPicker: mockOpenPicker })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import TransactionDetail from '../../app/transaction/[id]';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries } from './support/renderWithQueries';
import { COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const rollup = (over: Partial<BudgetRollup> = {}): BudgetRollup => ({ target: 100, posted: 40, pending: 10, ...over });

const seedSpend = (over: Partial<Transaction> = {}) =>
  server.seed('/transactions/feed', { transactions: [txn({ transaction_id: 't1', category: 'coffee', amount: -130, ...over })], nextCursor: null });

beforeEach(() => {
  resetRouter();
  setParams({ id: 't1' });
  resetAuth();
  // The taxonomy knows only 'coffee' — a budget on any other category has no category behind it.
  server.seed('/categories', [{ ...COFFEE_RECORD, parent: null }]);
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
});
