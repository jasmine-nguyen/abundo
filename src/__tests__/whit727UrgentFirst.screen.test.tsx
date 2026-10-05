// WHIT-727 — on the Budgets tab, an over-budget row shows above an on-pace row that comes
// before it in category order. Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { seedBudgetsTab } from './support/budgetsTab';
import { COFFEE, DINING } from './support/categories';

jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';
import { useBudgetsSuiteReset } from './support/budgetsSuite';

const server = installFakeServer();
useTestQueryClient();

useBudgetsSuiteReset();

it('shows the over-budget row before an on-pace row listed ahead of it', async () => {
  // 7 of 14 days left → pace is half the budget: coffee $50 of $100 is on pace, dining $150 of $100 is over.
  seedBudgetsTab(
    server,
    {
      coffee: { target: 100, posted: 50, pending: 0 },
      dining: { target: 100, posted: 150, pending: 0 },
    },
    [COFFEE, DINING],
  );
  await renderWithQueries(<Budgets />);
  await screen.findByText('Dining');
  const order = screen.getAllByText(/^(Cafes & Coffee|Dining)$/).map((n) => n.props.children);
  expect(order).toEqual(['Dining', 'Cafes & Coffee']);
});
