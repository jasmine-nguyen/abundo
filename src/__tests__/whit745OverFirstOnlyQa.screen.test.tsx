// WHIT-745 QA on screen: a pull-to-refresh with a fully used Mortgage still sends no charge-list
// lookups and doesn't move it; pending charges that tip it over do move it.
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { pullAndSettle } from './support/pull';
import { COFFEE, MORTGAGE_RECORD } from './support/categories';

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { resetAuth } from './support/authMock';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

const rowOrder = () =>
  screen.getAllByTestId(/^budget-row-(mortgage|coffee)$/).map((r) => r.props.testID);

// [A6] (P0) refreshing the tab doesn't bring the lookups back or lift the fully used bill.
it('a pull-to-refresh sends no charge-list lookups and keeps a fully used mortgage below coffee', async () => {
  seedBudgetsTab(
    server,
    {
      coffee: { target: 100, posted: 40, pending: 0 },
      mortgage: { target: 3667, posted: 3667, pending: 0 },
    },
    [COFFEE, MORTGAGE_RECORD],
  );
  await renderLoadedBudgetsWithQueries();
  await waitFor(() => expect(rowOrder()).toEqual(['budget-row-coffee', 'budget-row-mortgage']));
  await pullAndSettle();
  expect(rowOrder()).toEqual(['budget-row-coffee', 'budget-row-mortgage']);
  expect(server.sentUnder('GET', '/budgets/')).toEqual([]);
});

// [A7] (P1) a mortgage that tips over budget by pending charges moves above coffee on screen.
it('a mortgage pushed over by a pending charge moves above coffee', async () => {
  seedBudgetsTab(
    server,
    {
      coffee: { target: 100, posted: 40, pending: 0 },
      mortgage: { target: 3667, posted: 3600, pending: 100 },
    },
    [COFFEE, MORTGAGE_RECORD],
  );
  await renderLoadedBudgetsWithQueries();
  await waitFor(() => expect(rowOrder()).toEqual(['budget-row-mortgage', 'budget-row-coffee']));
});
