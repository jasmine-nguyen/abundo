// WHIT-794: the set-budget and add-a-budget screens no longer show made-up numbers (an average
// the server always sends as $0, and hard-coded history bars), nor the search box that did nothing.
// The pay-cycle budget label, the amount box and Save still work.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { routerSpies, setParams, resetRouter } from './support/routerMock';

const mockSaveBudget = jest.fn(async (_id: string, _amount: number, _rollover?: boolean) => true);

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveBudget: mockSaveBudget }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetEdit from '../../app/budget/edit';
import BudgetPick from '../../app/budget/pick';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { COFFEE_RECORD, SALARY } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const DUMMY_TEXT = [
  /^Recommended:/,
  'Use my average spend',
  'Use my average income',
  'View spending history',
  'View earning history',
  '6-cycle average',
  /^Last (week|fortnight|month)$/,
  'Set your income floor',
];

beforeEach(() => {
  resetRouter();
  mockSaveBudget.mockClear();
  resetAuth();
  server.seed('/categories', [COFFEE_RECORD, SALARY]);
  server.seed('/budgets', {});
});

describe('Set budget screen without dummy numbers', () => {
  it.each([
    ['a spend category', 'coffee'],
    ['an income category', 'salary'],
  ])('shows no recommendation, stats or history for %s, and still saves', async (_label, categoryId) => {
    setParams({ categoryId });
    await renderWithQueries(<BudgetEdit />);

    for (const text of DUMMY_TEXT) expect(screen.queryByText(text)).toBeNull();
    expect(screen.getByText(/ BUDGET$/)).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('0'), '300');
    await act(async () => { fireEvent.press(screen.getByText('Add budget')); });
    expect(mockSaveBudget).toHaveBeenCalledTimes(1);
    expect(mockSaveBudget.mock.calls[0][0]).toBe(categoryId);
    expect(mockSaveBudget.mock.calls[0][1]).toBe(300);
    await waitFor(() => expect(routerSpies.replace).toHaveBeenCalledWith('/(tabs)/budgets'));
  });
});

describe('Add a budget screen without dummy numbers', () => {
  it('lists categories with no average or search box, keeping the earn-target tag', async () => {
    await renderWithQueries(<BudgetPick />);

    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.getByText('Salary')).toBeTruthy();
    expect(screen.getByText('earn-target')).toBeTruthy();
    expect(screen.queryByText('avg / fortnight')).toBeNull();
    expect(screen.queryByText('$0')).toBeNull();
    expect(screen.queryByText('Search categories')).toBeNull();
  });
});
