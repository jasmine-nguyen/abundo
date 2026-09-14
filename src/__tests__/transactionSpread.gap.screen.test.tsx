// WHIT-556 4b — GAP tests for the "Spread this bill" tx-screen prompt the implementer's cases miss.
// Already covered by transactionDetail.screen.test.tsx: start(prefill = category overage)/edit(no
// prefill)/rollover-hidden/excluded-hidden/refund-hidden/no-budget-hidden/not-found/overage-not-charge.
// These add: the budget is keyed by the transaction's OWN category (not "any over budget"), and a
// PENDING spend still qualifies (settled status isn't required).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn, budget } from './factory';
import type { Budget } from '../context';

let mockTx: ReturnType<typeof txData>;
let mockBudgets: Budget[] = [];
jest.mock('../queries', () => ({
  useTransactionsScreenData: () => mockTx,
  useTransactionResolver: () => ({
    transactions: mockTx.transactions,
    findTx: (id: string) => (mockTx.transactions as { transaction_id: string }[]).find((t) => t.transaction_id === id),
  }),
  useBudgetsScreenData: () => ({ budgets: mockBudgets }),
  // WHIT-539: the detail screen reads the rules cache for the rule-attribution line; empty here.
  useRulesScreenData: () => ({ rules: [], isLoading: false }),
}));

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

let mockId = 't1';
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: jest.fn(), push: mockPush }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

// Resolver knows only 'coffee' (cat() default) — a tx on any other category resolves to no category.
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

const spendTx = (over = {}) => txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', amount: -130, ...over })] });

beforeEach(() => {
  mockId = 't1';
  mockTx = txData();
  mockBudgets = [];
  mockPush.mockClear();
  mockApplyTransactionEdit.mockClear();
  mockToast.mockClear();
  mockOpenPicker.mockClear();
});

describe('spread this bill prompt — gap coverage', () => {
  // [G3] The prompt must key the budget off the transaction's OWN category. An over-budget budget
  // for a DIFFERENT category must not leak the prompt onto an unrelated (under-budget) charge.
  it('[G3] keys the budget by the transaction category — an over budget on another category is ignored', () => {
    mockTx = spendTx(); // tx on 'coffee'
    mockBudgets = [
      budget({ id: 'coffee', budget: 100, posted: 40, pending: 0 }),      // coffee: UNDER budget
      budget({ id: 'groceries', budget: 100, posted: 400, pending: 0 }),   // some OTHER cat: way over
    ];
    render(<TransactionDetail />);
    expect(screen.queryByTestId('transaction-spread')).toBeNull();
  });

  // [G4] A pending spend (status 'pending', amount < 0) whose category envelope is over still
  // qualifies — the gate keys off amount sign + eligibility, not posted/settled status. The prefill
  // is the category overage (posted 60 + pending 70 = 130 → over by 30), not the tapped charge.
  it('[G4] a PENDING over-budget spend still offers the prompt, prefilled with the overage', () => {
    mockTx = spendTx({ status: 'pending' });
    mockBudgets = [budget({ id: 'coffee', budget: 100, posted: 60, pending: 70 })];
    render(<TransactionDetail />);
    fireEvent.press(screen.getByTestId('transaction-spread'));
    expect(mockPush).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=30');
  });
});
