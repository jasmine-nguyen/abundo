// WHIT-728 follow-up — on the Budgets tab, a rollover row pulled negative by a carried-over
// deficit shows "$617.75 of −$659" and the muted "Includes past overspend" under the bar.
// Real ../api over the fake server.
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

it('a rollover row in deficit shows "$617.75 of −$659" and "Includes past overspend"', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 200, posted: 617.75, pending: 0, rollover: true, carryover: -859, available: -659 },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByText(/^\$617\.75 of −\$659/)).toBeTruthy();
  expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes past overspend');
});

it('a spread row draws its note under the new id', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 41, posted: 617.75, pending: 0, spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 } },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes spread bills');
});
