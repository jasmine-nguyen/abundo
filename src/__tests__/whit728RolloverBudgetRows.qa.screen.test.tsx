// WHIT-728 follow-up QA — on the Budgets tab a rollover row with saved-up leftovers draws
// "Includes $40 past leftovers" under the bar, and a plain row draws no note at all.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
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

// [A3]
it('a rollover row with leftovers shows "Includes $40 past leftovers"', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 50, pending: 0, rollover: true, carryover: 40, available: 140 },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByText(/^\$50 of \$140/)).toBeTruthy();
  expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $40 past leftovers');
});

// [A4]
it('a plain row (no rollover, no spread) draws no note', async () => {
  seedBudgetsTab(server, { coffee: { target: 100, posted: 50, pending: 0 } });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByText(/^\$50 of \$100/)).toBeTruthy();
  expect(screen.queryByTestId('budget-row-note-coffee')).toBeNull();
});
