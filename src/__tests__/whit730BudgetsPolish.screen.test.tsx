// WHIT-730 — a budget with nothing spent yet draws as a slim row: no bar, but it keeps its
// muted note and still opens the budget. A budget with spending keeps its full card and bar.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { BudgetBar } from '../components/ui';
import { resetRouter, routerSpies } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { COFFEE, GROCERIES } from './support/categories';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

it('a $0 budget is a slim row with no bar that keeps its note and still opens the budget', async () => {
  seedBudgetsTab(server, {
    // Nothing spent; a spread cushion makes this cycle's budget $300 and adds the note.
    coffee: { target: 100, posted: 0, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
    groceries: { target: 100, posted: 30, pending: 0 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');

  expect(screen.UNSAFE_queryAllByType(BudgetBar)).toHaveLength(1);
  expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes spread bills');

  fireEvent.press(screen.getByText('Cafes & Coffee'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
});
