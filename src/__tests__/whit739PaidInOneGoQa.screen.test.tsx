// WHIT-739 QA on screen: which rows the Budgets tab fetches a charge list for, what a failed list
// does, and that the lists share the budget-detail cache key (so the existing refreshes reach them).
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, refreshInAct } from './support/renderWithQueries';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE, SALARY, SAVINGS, MORTGAGE_RECORD } from './support/categories';
import { queryClient } from '../queryClient';
import { budgetTransactionsKey } from '../queryKeys';
import { txn } from './factory';

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

const MORTGAGE_CHARGES = '/budgets/mortgage/transactions';
const charge = (id: string, amount: number) => txn({ transaction_id: id, category: 'mortgage', amount: -amount });
const FULL_MORTGAGE = { target: 3667, posted: 3667, pending: 0 };
const COFFEE_ON_PACE = { target: 100, posted: 40, pending: 0 };

it('[A8] fetches only for spend budgets with nothing left — not income, savings, unknown or a cent short', async () => {
  seedBudgetsTab(
    server,
    {
      coffee: { target: 100, posted: 99.99, pending: 0 },
      salary: { target: 5000, posted: 5000, pending: 0 },
      rainy: { target: 200, posted: 200, pending: 0 },
      ghost: { target: 50, posted: 50, pending: 0 },
      mortgage: FULL_MORTGAGE,
    },
    [COFFEE, SALARY, SAVINGS, MORTGAGE_RECORD],
  );
  await renderLoadedBudgetsWithQueries();
  await waitFor(() => expect(server.sent('GET', MORTGAGE_CHARGES)).toHaveLength(1));
  expect(server.sentUnder('GET', '/budgets/').map((r) => r.path)).toEqual([MORTGAGE_CHARGES]);
});

// Coffee is listed first and on pace, so the mortgage only goes above it while it's still urgent.
const rowOrder = () => screen.getAllByTestId(/^budget-row-(mortgage|coffee)$/).map((r) => r.props.testID);

it('[A9] a failed charge list leaves the paid mortgage urgent, with no error card', async () => {
  seedBudgetsTab(server, { coffee: COFFEE_ON_PACE, mortgage: FULL_MORTGAGE }, [COFFEE, MORTGAGE_RECORD]);
  server.fail(MORTGAGE_CHARGES, 500);
  await renderLoadedBudgetsWithQueries();
  await waitFor(() => expect(server.sent('GET', MORTGAGE_CHARGES)).toHaveLength(1));
  expect(rowOrder()).toEqual(['budget-row-mortgage', 'budget-row-coffee']);
  expect(screen.getByText('Mortgage')).toBeTruthy();
});

it('[A10] the list is cached under the budget-detail key, and its refresh moves the row', async () => {
  seedBudgetsTab(server, { coffee: COFFEE_ON_PACE, mortgage: FULL_MORTGAGE }, [COFFEE, MORTGAGE_RECORD]);
  server.seed(MORTGAGE_CHARGES, [charge('m1', 1833.5), charge('m2', 1833.5)]);
  await renderLoadedBudgetsWithQueries();
  await waitFor(() => expect(queryClient.getQueryData([...budgetTransactionsKey, 'mortgage'])).toHaveLength(2));
  expect(rowOrder()).toEqual(['budget-row-mortgage', 'budget-row-coffee']);

  // e.g. the user excludes one of the two charges → the exclusion refresh invalidates this prefix.
  server.seed(MORTGAGE_CHARGES, [charge('m1', 3667)]);
  await refreshInAct(() => queryClient.invalidateQueries({ queryKey: budgetTransactionsKey }));
  await waitFor(() => expect(rowOrder()).toEqual(['budget-row-coffee', 'budget-row-mortgage']));
});
