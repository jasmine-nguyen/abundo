// WHIT-741 QA — the Budgets polish on screen, beyond the main suite: no tick on a "$0 left" row,
// a note-only row keeps its 18pt band, the top card's label and value columns line up one-for-one,
// the days column sizes to its number, "−$" stays glued in the hero and the row, and the detail
// screen hides "today's plan" on a used-up budget. Real ../api over the fake server.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { C, MINUS } from '../theme';
import { setParams } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries, heroTotals } from './support/budgetsScreen';
import { COFFEE, GROCERIES, SALARY } from './support/categories';

jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import BudgetDetail from '../../app/budget/[id]';
import Budgets from '../../app/(tabs)/budgets';
import { useBudgetsSuiteReset } from './support/budgetsSuite';

const server = installFakeServer();
useTestQueryClient();
useBudgetsSuiteReset();

const ticksIn = (node: ReactTestInstance) =>
  node.findAll((n) => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.backgroundColor === C.progressTick);

const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};

// The nearest host (rendered) element above `node`.
function hostParent(node: ReactTestInstance) {
  let host = node.parent!;
  while (typeof host.type !== 'string') host = host.parent!;
  return host;
}

const isHostText = (n: ReactTestInstance) => String(n.type) === 'Text';

// Host Text children of a host row, in order.
const hostCells = (row: ReactTestInstance) => row.findAll((n) => isHostText(n) && hostParent(n) === row);

// The height of the band holding the first tick under `root`.
const tickBandHeight = (root: ReactTestInstance) => flat(hostParent(ticksIn(root)[0])).height;

// [A13] (P0) a fully used budget ("$0 left") shows its bar with no tick; a budget with money left keeps it.
it('[A13] "$0 left" row has no tick; a row with money left has one', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 100, pending: 0 },
    groceries: { target: 100, posted: 20, pending: 0 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');
  expect(ticksIn(screen.getByTestId('budget-row-coffee'))).toHaveLength(0);
  expect(ticksIn(screen.getByTestId('budget-row-groceries'))).toHaveLength(1);
});

// [A14] (P1) a row with a note but no pace line keeps today's 18pt band (critic tweak).
it('[A14] a note-only row keeps the full tick band', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 20, pending: 0, rollover: true, carryover: 40 },
  });
  await renderLoadedBudgetsWithQueries();
  expect(screen.getByTestId('budget-row-note-coffee')).toBeTruthy();
  expect(screen.queryByText(/over plan/)).toBeNull();
  expect(tickBandHeight(screen.getByTestId('budget-row-coffee'))).toBe(18);
});

// [A15] (P0) an earning row never shows a pending line, even with pending money.
it('[A15] income row with pending has no pending line', async () => {
  seedBudgetsTab(server, { salary: { target: 5000, posted: 1000, pending: 300 } }, [SALARY]);
  await renderWithQueries(<Budgets />);
  await screen.findByText('Salary');
  expect(screen.queryByTestId('budget-row-pending-salary')).toBeNull();
  const rowTexts = screen.getByTestId('budget-row-salary').findAll(isHostText).map((n) => String(n.props.children));
  expect(rowTexts.join(' ')).not.toMatch(/pending/);
});

// [A16] (P0) the top card: labels and values line up column for column (same count, same order,
// same flex), so "26 Oct" sits under "Next payday" whatever wraps.
it('[A16] hero labels and values are matching columns', async () => {
  seedBudgetsTab(server, { coffee: { target: 100, posted: 40, pending: 0 } });
  await renderLoadedBudgetsWithQueries();
  const valuesRow = hostParent(screen.getByTestId('budgets-hero-spent'));
  const labelsRow = hostParent(screen.getByText('Spent'));
  const labels = hostCells(labelsRow);
  const values = hostCells(valuesRow);
  expect(labels.map((l) => l.props.children)).toEqual(['Spent', 'Budget', 'Next payday']);
  expect(values.map((v) => v.props.testID)).toEqual(['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday']);
  labels.forEach((label, i) => expect(flat(label).flex).toBe(flat(values[i]).flex));
  expect(flat(labelsRow).flexDirection).toBe('row');
  expect(flat(valuesRow).flexDirection).toBe('row');
});

// [A17] (P0) the days column sizes to its number (no flex, never shrinks); the money column takes the rest.
it('[A17] days column is content-sized, money column flexes', async () => {
  seedBudgetsTab(server, { coffee: { target: 100, posted: 40, pending: 0 } });
  await renderLoadedBudgetsWithQueries();
  const daysCol = flat(hostParent(screen.getByText('7')));
  const moneyCol = flat(hostParent(screen.getByText('Left to spend')));
  expect(daysCol.flex).toBeUndefined();
  expect(daysCol.flexShrink).toBe(0);
  expect(moneyCol.flex).toBe(1);
  expect(moneyCol.minWidth).toBe(0);
});

// [A18] (P0) over budget: the hero amount and the Budget total keep the minus glued to "$".
it('[A18] hero "−$" amounts carry the word joiner', async () => {
  seedBudgetsTab(server, { coffee: { target: 100, posted: 120.5, pending: 0, spreadAdjustment: -150, spread: { amount: 450, cycles: 3, index: 1, adjustment: -150 } } });
  await renderLoadedBudgetsWithQueries();
  expect(heroTotals().budget).toBe(`${MINUS}$50`);
  expect(screen.getByText(`${MINUS}$170.50`)).toBeTruthy();
  expect(screen.getByText(`$120.50 of ${MINUS}$50`)).toBeTruthy();
});

// [A19] (P0) detail: a used-up budget hides the tick and "today's plan"; the "of" line has cents.
it('[A19] used-up budget detail: no "today\'s plan", "of $140.67"', async () => {
  setParams({ id: 'coffee' });
  seedBudgetsTab(server, { coffee: { target: 140.67, posted: 140.67, pending: 0 } });
  server.seed('/budgets/coffee/transactions', []);
  await renderWithQueries(<BudgetDetail />);
  expect(await screen.findByText('of $140.67')).toBeTruthy();
  expect(screen.queryByText("today's plan")).toBeNull();
});

// [A20] (P1) detail with money left keeps the default 18pt band (the tab's short tail doesn't leak).
it('[A20] budget detail with money left keeps "today\'s plan" and its 18pt band', async () => {
  setParams({ id: 'coffee' });
  seedBudgetsTab(server, { coffee: { target: 100, posted: 40, pending: 0 } });
  server.seed('/budgets/coffee/transactions', []);
  const view = await renderWithQueries(<BudgetDetail />);
  expect(await screen.findByText("today's plan")).toBeTruthy();
  const ticks = ticksIn(view.UNSAFE_root);
  expect(ticks).toHaveLength(1);
  expect(tickBandHeight(view.UNSAFE_root)).toBe(18);
});
