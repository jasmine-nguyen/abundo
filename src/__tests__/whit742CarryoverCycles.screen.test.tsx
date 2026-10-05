// WHIT-742 — the budget detail page lists the cycles behind a rollover's carryover under the note,
// with settling and estimated cycles tagged. The Budgets tab row keeps only the note. Real ../api
// and ../queries over the fake server.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { resetRouter, setParams } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';

jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetDetail from '../../app/budget/[id]';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

const UTILITIES = {
  target: 200, posted: 100, pending: 0, rollover: true, carryover: -879, available: -679,
  carryover_cycles: [
    { start: '2026-09-12', end: '2026-09-25', target: 200, spent: 720, leftover: -520, settling: true },
    { start: '2026-08-29', end: '2026-09-11', target: 200, spent: 539, leftover: -339, settling: false, rebuilt: true },
  ],
  carryover_earlier: -20,
};

it('the detail page lists each cycle under the carryover note, tagging settling and estimated ones', async () => {
  setParams({ id: 'coffee' });
  seedBudgetsTab(server, { coffee: UTILITIES });
  server.seed('/budgets/coffee/transactions', []);
  await renderWithQueries(<BudgetDetail />);

  await screen.findByText('Includes $879 past overspend');
  const first = within(screen.getByTestId('carryover-cycle-0'));
  expect(first.getByText(/12 Sep – 25 Sep/)).toBeTruthy();
  expect(first.getByText(/settling/)).toBeTruthy();
  expect(first.queryByText(/estimated/)).toBeNull();
  expect(first.getByText('−$520')).toBeTruthy();

  const second = within(screen.getByTestId('carryover-cycle-1'));
  expect(second.getByText(/estimated/)).toBeTruthy();
  expect(second.queryByText(/settling/)).toBeNull();
  expect(second.getByText('−$339')).toBeTruthy();

  const gap = within(screen.getByTestId('carryover-cycle-2'));
  expect(gap.getByText(/Not matched to a cycle/)).toBeTruthy();
  expect(gap.getByText('−$20')).toBeTruthy();
});

it('the Budgets tab row keeps only the note, no cycle lines', async () => {
  seedBudgetsTab(server, { coffee: UTILITIES });
  await renderLoadedBudgetsWithQueries();

  expect(screen.getByTestId('budget-row-note-coffee').props.children).toBe('Includes $879 past overspend');
  expect(screen.queryByTestId('carryover-cycle-0')).toBeNull();
});
