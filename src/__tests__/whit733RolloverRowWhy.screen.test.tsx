// WHIT-733 — on the Budgets tab, an over-budget rollover row shows the carried amount in its
// note and a "See what happened →" link that opens the budget's own screen.
// Real ../api over the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { routerSpies, resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
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

it('an over-budget rollover row names its past overspend and links to its budget screen', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859, available: -659 },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $859 past overspend');
  const link = screen.getByTestId('budget-row-see-why-coffee');
  expect(screen.getByText('See what happened →')).toBeTruthy();
  fireEvent.press(link);
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
});

it('a non-rollover over-budget row has no see-why link', async () => {
  seedBudgetsTab(server, { coffee: { target: 100, posted: 150, pending: 0 } });
  await renderLoadedBudgetsWithQueries();
  expect(screen.queryByTestId('budget-row-see-why-coffee')).toBeNull();
  expect(screen.queryByText('See what happened →')).toBeNull();
});
