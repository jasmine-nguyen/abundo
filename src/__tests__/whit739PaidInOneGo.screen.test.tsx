// WHIT-739 on screen: the Budgets tab fetches the charge list for a budget with nothing left, and a
// bill paid in one go (Mortgage) is not urgent, so it sits below a real over-plan row.
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries } from './support/budgetsScreen';
import { COFFEE } from './support/categories';
import { txn } from './factory';
import { queryClient } from '../queryClient';
import { budgetTransactionsKey } from '../queryKeys';

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
const MORTGAGE = { id: 'mortgage', name: 'Mortgage', bucket: 'Living', icon: 'home' };
const charge = (id: string, amount: number) => txn({ transaction_id: id, category: 'mortgage', amount: -amount });

// Halfway through a 14-day cycle: Mortgage paid in full, Coffee $85 of $100 (a real over-plan row).
function seedPaidMortgage(mortgageCharges: ReturnType<typeof txn>[]) {
  seedBudgetsTab(
    server,
    { mortgage: { target: 3667, posted: 3667, pending: 0 }, coffee: { target: 100, posted: 85, pending: 0 } },
    [MORTGAGE, COFFEE],
  );
  server.seed(MORTGAGE_CHARGES, mortgageCharges);
}

const rowOrder = () => screen.getAllByTestId(/^budget-row-(mortgage|coffee)$/).map((r) => r.props.testID);

it('a mortgage paid in one charge sits below the over-plan row', async () => {
  seedPaidMortgage([charge('m1', 3667)]);
  await renderLoadedBudgetsWithQueries();
  await waitFor(() => expect(rowOrder()).toEqual(['budget-row-coffee', 'budget-row-mortgage']));
  expect(server.sent('GET', MORTGAGE_CHARGES)).toHaveLength(1);
  expect(server.sent('GET', '/budgets/coffee/transactions')).toHaveLength(0);
});

it('a mortgage used up by two charges is still urgent, ahead of the over-plan row', async () => {
  seedPaidMortgage([charge('m1', 1833.5), charge('m2', 1833.5)]);
  await renderLoadedBudgetsWithQueries();
  await waitFor(() => expect(queryClient.getQueryData([...budgetTransactionsKey, 'mortgage'])).toHaveLength(2));
  expect(rowOrder()).toEqual(['budget-row-mortgage', 'budget-row-coffee']);
});
