// WHIT-728 QA — the top card's Budget total keeps its minus (fold-in), and a spread row that is
// also off pace shows the note AND the pace label in the line under the bar.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

// [A1] the only spend budget is in payback → the top card's Budget reads −$659, not $659.
it('the top card budget total keeps the minus on a payback cycle', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 41, posted: 617.75, pending: 0, spread: { amount: 2100, cycles: 3, index: 1, adjustment: -700 } },
  });
  await renderLoadedBudgetsWithQueries();
  expect(heroTotals().budget).toBe('−$659');
});

// [A2] a cushion row that is behind pace → the note on the left AND the pace label both drawn.
it('a behind-pace spread row shows the note and keeps its pace label', async () => {
  seedBudgetsTab(server, {
    // $100 + $200 cushion = $300 available; pace runs on the $100 target, so $200 spent is behind.
    coffee: { target: 100, posted: 200, pending: 0, spread: { amount: 600, cycles: 3, index: 0, adjustment: 200 } },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByTestId('budget-row-spread-note-coffee').props.children).toBe('Includes spread bills');
  expect(screen.getByText(/behind pace$/)).toBeTruthy();
  expect(screen.getByText(/^\$200 of \$300/)).toBeTruthy();
});
