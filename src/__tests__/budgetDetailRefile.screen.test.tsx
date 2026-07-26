// The budget-detail Related Transactions rows now reuse the shared TransactionRow, so each row
// has the trailing arrow that opens the transaction (where "Change category" refiles it) — the
// same control the Transactions screen has. This is an integration check on the budget screen:
// the arrow renders per row and routes to /transaction/<id>. The tap→openPicker behaviour of the
// shared row is unit-tested in TransactionRow.screen.test.tsx.
// ../queries re-routed via the shared screenQueryMocks harness; ../context real; expo-router stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

let mockState: ScreenState;
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }) };
});

// The row's trailing arrow routes to the detail page via useRouter — capture push to assert it.
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BUDGETS = [{ id: 'coffee', budget: 80, posted: 15, pending: 5 }];

function charge(over: Record<string, unknown>) {
  return {
    transaction_id: 't1', date: '2026-07-20', authorized_date: '2026-07-20',
    description: 'CAFE', merchant_name: 'Cafe', amount: -5,
    account_id: 'a1', account_name: 'Everyday', category: 'coffee',
    status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockState = { categories: CATS, budgets: BUDGETS, transactions: [charge({})], cycleLen: 30, daysLeft: 5, payCycleError: false };
});

it('gives every related transaction a details arrow', () => {
  mockState = { ...mockState, transactions: [charge({ transaction_id: 't1' }), charge({ transaction_id: 't2' }), charge({ transaction_id: 't3' })] };
  render(<BudgetDetail />);

  expect(screen.getAllByLabelText('View transaction details')).toHaveLength(3);
});

it('tapping a row arrow opens that transaction (where it can be refiled)', () => {
  render(<BudgetDetail />);

  fireEvent.press(screen.getAllByLabelText('View transaction details')[0]);

  expect(mockPush).toHaveBeenCalledWith('/transaction/t1');
});

it('still shows the Pending badge on a pending charge (shared row keeps it)', () => {
  mockState = { ...mockState, transactions: [charge({ status: 'pending' })] };
  render(<BudgetDetail />);

  expect(screen.getByText('Pending')).toBeTruthy();
});
