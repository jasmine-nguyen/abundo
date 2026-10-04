// WHIT-713 — draw the real Budgets tab over the fake server, with the fixtures the Budgets suites
// share. The screen data code (../queries) runs for real. Usage in a suite (the jest.mock calls
// must stay in the test file, for hoisting):
//
//   jest.mock('../auth', ...);
//   jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
//   const server = installFakeServer();
//   beforeEach(() => seedBudgets(server));
//   renderBudgets();
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import React from 'react';
import { render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Budgets from '../../../app/(tabs)/budgets';
import { makeClient } from './queryClient';

export { BUDGETS, BUDGET_PAY_CYCLE, seedBudgets } from './budgetsTab';

export function renderBudgets(client: QueryClient = makeClient()) {
  return { client, ...render(<QueryClientProvider client={client}><Budgets /></QueryClientProvider>) };
}
