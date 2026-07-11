// WHIT-250: happy-path tap test for the Budget save button. budgetEditIncome only asserts
// render states — nothing ever pressed Save. This presses the real button and asserts
// saveBudget fires once + navigation to the budgets tab, so an onPress rewired to the wrong
// handler (app/budget/edit.tsx) turns it red.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext } from '../context';

// Hoisted module-scope mocks so replace() + the writer are assertable across renders
// (see the delete test — useRouter() returns a fresh object each render).
const mockSaveBudget = jest.fn(async (_id: string, _amount: number) => true);
const mockReplace = jest.fn();

const SPEND = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 };
let mockState: AppContext;
const mockParams = { categoryId: 'coffee' };

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, dismissAll: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

import BudgetEdit from '../../app/budget/edit';

beforeEach(() => { mockSaveBudget.mockClear(); mockReplace.mockClear(); });

it('pressing Add budget saves the amount once and navigates to the budgets tab', async () => {
  // SPEND category (not Income/Savings) with no existing budget → save button reads 'Add budget'.
  // saveBudget is read off useAppContext(); the query hooks are re-routed from mockState.
  mockState = {
    categories: [SPEND],
    budgets: [],
    saveBudget: mockSaveBudget,
  } as unknown as AppContext;
  render(<BudgetEdit />);

  fireEvent.changeText(screen.getByPlaceholderText('0'), '300');
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); });

  // The real onPress→save()→saveBudget chain fired with the parsed number, then navigated.
  expect(mockSaveBudget).toHaveBeenCalledTimes(1);
  expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 300);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
});
