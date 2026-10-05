// WHIT-745 on screen: only an over-budget row moves up. A fully used (behind-pace) Mortgage keeps its
// category place below Coffee, and the Budgets tab sends no charge-list lookups.
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE, GROCERIES_RECORD, MORTGAGE_RECORD } from './support/categories';

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
  screen.getAllByTestId(/^budget-row-(mortgage|coffee|groceries)$/).map((r) => r.props.testID);

it('lifts only the over-budget row; a fully used mortgage keeps its place and no charge lists are fetched', async () => {
  // Halfway through a 14-day cycle: Coffee on pace, Mortgage fully used (behind pace), Groceries over.
  seedBudgetsTab(
    server,
    {
      coffee: { target: 100, posted: 40, pending: 0 },
      mortgage: { target: 3667, posted: 3667, pending: 0 },
      groceries: { target: 100, posted: 150, pending: 0 },
    },
    [COFFEE, MORTGAGE_RECORD, GROCERIES_RECORD],
  );
  await renderLoadedBudgetsWithQueries();
  await waitFor(() =>
    expect(rowOrder()).toEqual(['budget-row-groceries', 'budget-row-coffee', 'budget-row-mortgage']),
  );
  expect(server.sentUnder('GET', '/budgets/')).toEqual([]);
});
