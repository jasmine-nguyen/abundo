// The budget-detail related-transactions list now shows the WHOLE cycle (server-filtered
// to the subtree), paged client-side: first 7 rows, then a "Load More" button reveals the
// next page. Locks that the list is not truncated to a fixed slice and Load More works.
// ../queries re-routed via the shared screenQueryMocks harness; ../context real (budgetDetail
// + transactionView stay pure); expo-router stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

let mockState: ScreenState;
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn() }) };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BUDGETS = [{ id: 'coffee', budget: 80, posted: 52, pending: 0 }];

// 9 cycle charges, all one date so they form a single group rendered in list order.
function nCharges(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    transaction_id: `t${i + 1}`, date: '2026-07-20', authorized_date: '2026-07-20',
    description: `CAFE ${i + 1}`, merchant_name: `Cafe ${i + 1}`, amount: -5,
    account_id: 'a1', account_name: 'Everyday', category: 'coffee',
    status: 'posted', type: 'purchase', counts_to_budget: true,
  }));
}

beforeEach(() => {
  mockState = { categories: CATS, budgets: BUDGETS, transactions: nCharges(9), cycleLen: 30, daysLeft: 5, payCycleError: false };
});

it('shows the first 7 rows with a Load More button, then reveals the rest on press', () => {
  render(<BudgetDetail />);

  expect(screen.getAllByTestId('budget-tx-row')).toHaveLength(7);
  const loadMore = screen.getByTestId('budget-load-more');

  fireEvent.press(loadMore);

  expect(screen.getAllByTestId('budget-tx-row')).toHaveLength(9);
  // All revealed → the button is gone.
  expect(screen.queryByTestId('budget-load-more')).toBeNull();
});

it('shows no Load More button when the cycle has 7 or fewer charges', () => {
  mockState = { ...mockState, transactions: nCharges(7) };
  render(<BudgetDetail />);

  expect(screen.getAllByTestId('budget-tx-row')).toHaveLength(7);
  expect(screen.queryByTestId('budget-load-more')).toBeNull();
});

it('shows the empty copy when the budget has no charges this cycle', () => {
  mockState = { ...mockState, transactions: [] };
  render(<BudgetDetail />);

  expect(screen.queryByTestId('budget-tx-row')).toBeNull();
  expect(screen.getByText('No transactions in this category this cycle.')).toBeTruthy();
});
