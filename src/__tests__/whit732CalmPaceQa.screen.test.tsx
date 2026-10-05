// WHIT-732 QA on screen: the Budgets tab lifts only a row that must slow down to the top (no
// pace text, WHIT-744), and the detail screen's "today's plan" label sits on the base pace
// of a rollover envelope. Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import { setParams } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE, GROCERIES } from './support/categories';

jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetDetail from '../../app/budget/[id]';
import { useBudgetsSuiteReset } from './support/budgetsSuite';

const server = installFakeServer();
useTestQueryClient();

useBudgetsSuiteReset({ pinClock: false });

// [A14] (P0) halfway through: $70 of $100 is calm; $85 of $100 must slow down, so it's listed first.
it('[A14] a slightly-ahead row stays in place; a row that must slow down moves up, with no pace text', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 70, pending: 0 },
    groceries: { target: 100, posted: 85, pending: 0 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');
  const order = screen.getAllByTestId(/^budget-row-(coffee|groceries)$/).map((r) => r.props.testID);
  expect(order).toEqual(['budget-row-groceries', 'budget-row-coffee']);
  expect(screen.queryByText(/over plan/)).toBeNull();
});
// [A15] (P0) detail: rollover $100 + $100 buffer, halfway → base pace $50 sits a quarter along.
it("[A15] the detail's \"today's plan\" label sits on the base pace of a rollover envelope", async () => {
  setParams({ id: 'coffee' });
  seedBudgetsTab(server, { coffee: { target: 100, posted: 30, pending: 0, rollover: true, carryover: 100, available: 200 } });
  server.seed('/budgets/coffee/transactions', []);
  await renderWithQueries(<BudgetDetail />);
  const label = await screen.findByText("today's plan");
  expect(StyleSheet.flatten(label.props.style).left).toBe('25%');
});
