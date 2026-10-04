// WHIT-713 — draw the real Budgets tab over the fake server, with the fixtures the Budgets suites
// share. The screen data code (../queries) runs for real. Usage in a suite (the jest.mock calls
// must stay in the test file, for hoisting):
//
//   jest.mock('../auth', ...);
//   jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
//   const server = installFakeServer();
//   beforeEach(() => seedBudgets(server));
//   renderBudgets();                          // draw the tab
//   await renderLoadedBudgets();              // draw it and wait for the coffee row
//   await renderLoadedBudgetsWithQueries();   // same, over the app's shared query client (call useTestQueryClient() at file scope)
//   await showBudgets(server, budgets, opts); // seed coffee + groceries (4 days left), draw, wait
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Budgets from '../../../app/(tabs)/budgets';
import { makeClient } from './queryClient';
import { renderWithQueries } from './renderWithQueries';
import type { installFakeServer } from './fakeServer';
import { COFFEE, GROCERIES } from './categories';
import { BUDGET_PAY_CYCLE, seedBudgets } from './budgetsTab';

export { BUDGETS, BUDGET_PAY_CYCLE, seedBudgets } from './budgetsTab';

export function renderBudgets(client: QueryClient = makeClient()) {
  return { client, ...render(<QueryClientProvider client={client}><Budgets /></QueryClientProvider>) };
}

export async function renderLoadedBudgets(client?: QueryClient) {
  const view = renderBudgets(client);
  await screen.findByText('Cafes & Coffee');
  return view;
}

export async function renderLoadedBudgetsWithQueries() {
  const view = await renderWithQueries(<Budgets />);
  await screen.findByText('Cafes & Coffee');
  return view;
}

type ShowOpts = { categories?: object; daysLeft?: number };

export async function showBudgets(
  server: ReturnType<typeof installFakeServer>,
  budgets: object,
  { categories = [COFFEE, GROCERIES], daysLeft = 4 }: ShowOpts = {},
) {
  seedBudgets(server, { budgets, categories, payCycle: { ...BUDGET_PAY_CYCLE, days_left: daysLeft } });
  return renderLoadedBudgets();
}

// WHIT-731: the top card's Spent · Budget · Next payday values (undefined when a cell isn't shown).
export function heroTotals() {
  const value = (id: string) => screen.queryByTestId(`budgets-hero-${id}`)?.props.children as string | undefined;
  return { spent: value('spent'), budget: value('budget'), payday: value('payday') };
}

// WHIT-730 follow-up: a budget row's effective left/right padding, by its testID.
export function sidePadding(testID: string) {
  const style = StyleSheet.flatten(screen.getByTestId(testID).props.style);
  return {
    left: style.paddingLeft ?? style.paddingHorizontal ?? style.padding,
    right: style.paddingRight ?? style.paddingHorizontal ?? style.padding,
  };
}
