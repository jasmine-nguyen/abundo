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
import type { installFakeServer } from './fakeServer';

export const BUDGET_CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 }];
export const BUDGETS = { coffee: { target: 100, posted: 40, pending: 10 } };
export const BUDGET_PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };

type Seed = { payCycle?: object; budgets?: object; categories?: object };

export function seedBudgets(server: ReturnType<typeof installFakeServer>, seed: Seed = {}) {
  server.seed('/budgets', seed.budgets ?? BUDGETS);
  server.seed('/categories', seed.categories ?? BUDGET_CATS);
  server.seed('/paycycle', seed.payCycle ?? BUDGET_PAY_CYCLE);
}

export function renderBudgets(client: QueryClient = makeClient()) {
  return { client, ...render(<QueryClientProvider client={client}><Budgets /></QueryClientProvider>) };
}
