// Budget ROLLOVER — editor screen wiring (QA, budget-rollover feature).
// budgetRollover.logic.test.ts locks budgetEditInfo (rolloverAllowed/rolloverOn); NO screen
// test proves app/budget/edit.tsx WIRES the Switch. This renders the real screen and proves:
//   * a spend budget shows the toggle; flipping it ON and saving passes rollover=true,
//   * an existing budget with rollover ON SEEDS the toggle on (Update saves true unchanged),
//   * an Income category HIDES the toggle and saves rollover=undefined (spend-only guard).
// Fail-on-revert: dropping the `info.rolloverAllowed &&` gate or the save arg turns these red.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { Switch } from 'react-native';
import type { AppContext } from '../context';

const mockSaveBudget = jest.fn(async (_id: string, _amount: number, _rollover?: boolean) => true);
const mockReplace = jest.fn();

const SPEND = { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52 };
const INCOME = { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#7fd49b', bucket: 'Income', recent: 0 };
let mockState: AppContext;
let mockParams: { categoryId: string } = { categoryId: 'coffee' };

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

it('spend budget: flipping the rollover toggle ON makes Save pass rollover=true', async () => {
  mockParams = { categoryId: 'coffee' };
  mockState = { categories: [SPEND], budgets: [], saveBudget: mockSaveBudget } as unknown as AppContext;
  const { UNSAFE_getByType } = render(<BudgetEdit />);

  expect(screen.getByText('Roll over unused budget')).toBeTruthy();   // the toggle row is shown
  fireEvent.changeText(screen.getByPlaceholderText('0'), '300');
  fireEvent(UNSAFE_getByType(Switch), 'valueChange', true);           // user turns rollover ON
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); });

  expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 300, true);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/budgets'));
});

it('existing rollover-ON budget SEEDS the toggle on, so Update saves rollover=true unchanged', async () => {
  mockParams = { categoryId: 'coffee' };
  mockState = {
    categories: [SPEND],
    // existing budget already has rollover ON — the editor must seed the Switch from it.
    budgets: [{ id: 'coffee', budget: 100, posted: 0, pending: 0, rollover: true, carryover: 0 }],
    saveBudget: mockSaveBudget,
  } as unknown as AppContext;
  const { UNSAFE_getByType } = render(<BudgetEdit />);

  expect(UNSAFE_getByType(Switch).props.value).toBe(true);            // seeded ON from existing.rollover
  await act(async () => { fireEvent.press(screen.getByText('Update budget')); });

  expect(mockSaveBudget).toHaveBeenCalledWith('coffee', 100, true);   // not silently flipped off
});

it('income category: no rollover toggle, and Save passes rollover=undefined (spend-only)', async () => {
  mockParams = { categoryId: 'salary' };
  mockState = { categories: [INCOME], budgets: [], saveBudget: mockSaveBudget } as unknown as AppContext;
  const { UNSAFE_queryAllByType } = render(<BudgetEdit />);

  expect(screen.queryByText('Roll over unused budget')).toBeNull();   // toggle hidden for Income
  expect(UNSAFE_queryAllByType(Switch)).toHaveLength(0);
  fireEvent.changeText(screen.getByPlaceholderText('0'), '5000');
  await act(async () => { fireEvent.press(screen.getByText('Add budget')); });

  expect(mockSaveBudget).toHaveBeenCalledWith('salary', 5000, undefined);
});
