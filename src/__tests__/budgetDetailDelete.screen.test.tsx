// WHIT-203: happy-path + failure tap tests for the Budget detail screen's Delete button
// (app/budget/[id].tsx). Presses the real button and asserts deleteBudget fires once and,
// on success, navigation back to the Budgets tab. Fail-on-revert: rewire onPress to the
// wrong handler (or drop router.back on success) and these turn red.
// ../queries re-routed via the shared screenQueryMocks harness; ../context stubbed for
// useAppContext only (the real budgetDetail/transactionView stay pure); expo-router stubbed.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { ScreenState } from './support/screenQueryMocks';

// Hoisted module-scope mocks so back() + the writer are assertable across renders
// (useRouter() returns a fresh object each render).
const mockDeleteBudget = jest.fn(async (_id: string) => true);
const mockBack = jest.fn();

let mockState: ScreenState;
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: mockDeleteBudget }) };
});

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: mockBack }),
  useLocalSearchParams: () => ({ id: 'coffee' }),
}));

import BudgetDetail from '../../app/budget/[id]';

// A valid, non-Savings/Income category + its budget row → budgetDetail() returns non-null,
// so the full detail (with the Delete button) renders.
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BUDGETS = [{ id: 'coffee', budget: 100, posted: 40, pending: 10 }];

beforeEach(() => {
  mockDeleteBudget.mockClear();
  mockBack.mockClear();
  mockDeleteBudget.mockResolvedValue(true);
  mockState = { categories: CATS, budgets: BUDGETS, transactions: [], cycleLen: 30, daysLeft: 12, payCycleError: false };
});

it('pressing Delete budget removes this budget once and navigates back to the Budgets tab', async () => {
  render(<BudgetDetail />);

  await act(async () => { fireEvent.press(screen.getByText('Delete budget')); });

  expect(mockDeleteBudget).toHaveBeenCalledTimes(1);
  expect(mockDeleteBudget).toHaveBeenCalledWith('coffee');
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
});

it('a failed delete stays on the screen (no navigation) so the user can retry', async () => {
  mockDeleteBudget.mockResolvedValue(false);
  render(<BudgetDetail />);

  await act(async () => { fireEvent.press(screen.getByText('Delete budget')); });

  expect(mockDeleteBudget).toHaveBeenCalledTimes(1);
  expect(mockBack).not.toHaveBeenCalled();
});
