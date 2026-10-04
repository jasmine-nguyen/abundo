// WHIT-728 — the Budgets tab row keeps the minus on a negative (payback) budget and shows a
// muted "Includes spread bills" in the line under the bar. Real ../api over the fake server.
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

it('a payback row shows "$617.75 of −$659" and the spread note', async () => {
  seedBudgetsTab(server, {
    // $41 target − $700 payback slice → this cycle's budget is −$659.
    coffee: { target: 41, posted: 617.75, pending: 0, spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 } },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByText(/^\$617\.75 of −\$659/)).toBeTruthy();
  expect(screen.getByTestId('budget-row-spread-note-coffee').props.children).toBe('Includes spread bills');
});

it('an on-pace row with a spread cushion still draws the note under the bar', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 150, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByTestId('budget-row-spread-note-coffee').props.children).toBe('Includes spread bills');
});
