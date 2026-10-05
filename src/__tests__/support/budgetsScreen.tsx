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
import type { ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Budgets from '../../../app/(tabs)/budgets';
import { makeClient } from './queryClient';
import { renderWithQueries } from './renderWithQueries';
import type { installFakeServer } from './fakeServer';
import { COFFEE, GROCERIES } from './categories';
import { BUDGET_PAY_CYCLE, seedBudgets, seedBudgetsTab } from './budgetsTab';

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

// Halfway through a 14-day cycle (7 days left), so a $100 budget's pace target is $50.
// Coffee: $80 spent ($10 pending) → behind pace. Groceries: $25 spent, nothing
// pending → on pace, no note. Totals: spent $105 of $200 → $95 left (WHIT-741, WHIT-743).
export async function showTwoRows(server: ReturnType<typeof installFakeServer>) {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 70, pending: 10 },
    groceries: { target: 100, posted: 25, pending: 0 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');
}

// WHIT-731: the top card's Spent · Budget · Next payday values (undefined when a cell isn't shown).
export function heroTotals() {
  const value = (id: string) => screen.queryByTestId(`budgets-hero-${id}`)?.props.children as string | undefined;
  return { spent: value('spent'), budget: value('budget'), payday: value('payday') };
}

// WHIT-730 follow-up: a node's effective left/right padding.
export function sidePaddingOf(node: ReactTestInstance) {
  const style = StyleSheet.flatten(node.props.style) ?? {};
  return {
    left: style.paddingLeft ?? style.paddingHorizontal ?? style.padding,
    right: style.paddingRight ?? style.paddingHorizontal ?? style.padding,
  };
}

// WHIT-730 follow-up: a budget row's effective left/right padding, by its testID.
export function sidePadding(testID: string) {
  return sidePaddingOf(screen.getByTestId(testID));
}

// WHIT-737: host ancestors (node up to the root) that pad the right more than the left — a lane.
export function rightOnlyGaps(node: ReactTestInstance) {
  const gaps: { testID?: string; left?: unknown; right?: unknown }[] = [];
  for (let host: ReactTestInstance | null = node; host; host = host.parent) {
    if (typeof host.type !== 'string') continue;
    const { left, right } = sidePaddingOf(host);
    if ((Number(right) || 0) > (Number(left) || 0)) gaps.push({ testID: host.props.testID, left, right });
  }
  return gaps;
}
