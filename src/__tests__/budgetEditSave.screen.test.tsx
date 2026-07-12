// WHIT-250: happy-path tap test for the Budget save button. budgetEditIncome only asserts
// render states — nothing ever pressed Save. This presses the real button and asserts
// saveBudget fires once + navigation to the budgets tab, so an onPress rewired to the wrong
// handler (app/budget/edit.tsx) turns it red.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
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

// Restore any per-test console.error spy even if a test fails mid-body (targets console.error
// only, so jest.setup's console.warn silence stays intact).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

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

// WHIT-249: an UNEXPECTED saveBudget throw used to leave the Add budget button stuck disabled
// (the caller's setSubmitting(false) sits on the false-return branch, which a throw skips). The
// handler now resets `submitting` in a catch (and re-throws so the guard logs). Fail-on-revert:
// drop the catch → the 2nd press early-returns on the stuck `submitting` flag → saveBudget once.
it('re-enables the Add budget button so a retry runs after saveBudget throws', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockState = {
    categories: [SPEND],
    budgets: [],
    saveBudget: mockSaveBudget,
  } as unknown as AppContext;
  mockSaveBudget.mockRejectedValueOnce(new Error('network blew up'));
  render(<BudgetEdit />);

  fireEvent.changeText(screen.getByPlaceholderText('0'), '300');
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); }); // throws → guard logs
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); }); // only fires if re-enabled

  expect(mockSaveBudget).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
  expect(errorSpy).toHaveBeenCalled();
});
