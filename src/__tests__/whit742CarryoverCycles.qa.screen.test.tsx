// WHIT-742 QA — the budget detail page on the day this ships: no cycles saved yet, so the whole
// carryover reads as one "Earlier cycles" line. Real ../api and ../queries over the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { resetRouter, setParams } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';

jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetDetail from '../../app/budget/[id]';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
  setParams({ id: 'coffee' });
  server.seed('/budgets/coffee/transactions', []);
});

// [C7] (P0) A budget saved before this change: one "Earlier cycles" line for the whole amount.
it('with no saved cycles the whole carryover shows as one "Earlier cycles" line', async () => {
  seedBudgetsTab(server, { coffee: {
    target: 200, posted: 100, pending: 0, rollover: true, carryover: -859, available: -659,
    carryover_cycles: [], carryover_earlier: -859,
  } });
  await renderWithQueries(<BudgetDetail />);

  await screen.findByText('Includes $859 past overspend');
  const only = within(screen.getByTestId('carryover-cycle-0'));
  expect(only.getByText(/Earlier cycles/)).toBeTruthy();
  expect(only.getByText('−$859')).toBeTruthy();
  expect(screen.queryByTestId('carryover-cycle-1')).toBeNull();
});

// [C8] (P1) A row from a server that hasn't shipped the new fields still renders the note alone.
it('a rollover row without the new fields shows the note and no cycle lines', async () => {
  seedBudgetsTab(server, { coffee: {
    target: 200, posted: 100, pending: 0, rollover: true, carryover: 136, available: 336,
  } });
  await renderWithQueries(<BudgetDetail />);

  await screen.findByText('Includes $136 past leftovers');
  expect(screen.queryByTestId('carryover-cycle-0')).toBeNull();
});
