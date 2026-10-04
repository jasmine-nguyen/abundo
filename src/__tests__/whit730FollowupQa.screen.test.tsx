// WHIT-730 follow-up QA — edges the main suites skip: nested slim rows line up, the spread link
// keeps its accent + bold, the top summary cards stay full width, and the Insights earning rows
// and Transactions' Load More sit in the gap too. ([A5] lives in whit730FollowupQaLane.)
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { C } from '../theme';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { routerSpies } from './support/routerMock';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries, sidePadding } from './support/budgetsScreen';
import { seedGoalsHub } from './support/goalsScreen';
import { breakdownWire, seedInsights } from './support/insightsScreen';
import { COFFEE, GROCERIES, LATTE, SALARY } from './support/categories';
import { expectClearsAskButton, findAskButtonClearance } from './support/askButtonClearance';
import { BudgetBar } from '../components/ui';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Budgets from '../../app/(tabs)/budgets';
import Transactions from '../../app/(tabs)/transactions';
import Insights from '../../app/(tabs)/insights';
import Goals from '../../app/(tabs)/goals';

const server = installFakeServer();
useTestQueryClient();

const PAY_CYCLE = { length: 14, last_pay_date: '2026-09-12' };

beforeEach(() => {
  resetListTabs(server);
});

const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style);

// [A1] (P0) a nested slim $0 row (Lattes under Coffee) keeps the full row's 16pt sides and its indent.
it('[A1] a nested slim $0 row lines up with its full parent row and keeps its indent', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 30, pending: 0 },
    latte: { target: 50, posted: 0, pending: 0 },
  }, [COFFEE, LATTE]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Lattes');

  expect(sidePadding('budget-row-latte')).toEqual(sidePadding('budget-row-coffee'));
  expect(sidePadding('budget-row-latte')).toEqual({ left: 16, right: 16 });
  expect(flat(screen.getByTestId('budget-row-latte')).marginLeft).toBe(18);
  // Still slim: tighter top/bottom than the full row.
  expect(flat(screen.getByTestId('budget-row-latte')).paddingTop).toBe(12);
  expect(flat(screen.getByTestId('budget-row-latte')).paddingBottom).toBe(12);
});

// [A2] (P0) the slim row is still slim (one bar on screen: the full row's), shows no pace line, and opens.
it('[A2] the slim row has no bar or pace line and still opens its budget', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 0, pending: 0 },
    groceries: { target: 100, posted: 30, pending: 0 },
  }, [COFFEE, GROCERIES]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');

  expect(screen.UNSAFE_queryAllByType(BudgetBar)).toHaveLength(1);
  expect(screen.queryByText('$50 under plan')).toBeNull();
  fireEvent.press(screen.getByTestId('budget-row-coffee'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/coffee');
});

// [A3] (P0) the spread link is neither behind pace nor under plan: it keeps its accent colour and bold.
it('[A3] the "Spread it over pay cycles →" link stays accent and bold', async () => {
  seedBudgetsTab(server, { coffee: { target: 80, posted: 90.25, pending: 0 } });
  await renderLoadedBudgetsWithQueries();

  const spread = flat(await screen.findByText('Spread it over pay cycles →'));
  expect(spread.color).toBe(C.accentSoft);
  expect(spread.fontWeight).toBe('700');
});

// [A4] (P0) "under plan" on a nested row is muted too (grey, not bold).
it('[A4] a nested row\'s "under plan" is grey and not bold', async () => {
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 30, pending: 0 },
    latte: { target: 100, posted: 10, pending: 0 },
  }, [COFFEE, LATTE]);
  await renderLoadedBudgetsWithQueries();

  const under = flat(await screen.findByText('$40 under plan'));
  expect(under.color).toBe(C.textDim);
  expect(under.fontWeight).toBe('400');
});

// [A6] (P1) the top summary cards stay full width — outside the gap — on Budgets, Insights and Goals.
it('[A6] Budgets: the top card stays full width; the rows sit in the gap', async () => {
  seedBudgetsTab(server, { groceries: { target: 100, posted: 30, pending: 0 } }, [GROCERIES]);
  await renderWithApp(<Budgets />);
  expectClearsAskButton(await screen.findByText('Groceries'));
  expect(findAskButtonClearance(screen.getByTestId('budgets-hero-spent'))).toBeNull();
});

it('[A6] Insights: the hero, donut and earned-vs-spent card stay full width', async () => {
  seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: { posted: 40, pending: 0 } }, earned: 100 }), categories: [{ ...COFFEE, recent: 0 }], payCycle: PAY_CYCLE });
  await renderWithApp(<Insights />);
  expectClearsAskButton(await screen.findByText('Cafes & Coffee'));
  expect(findAskButtonClearance(screen.getByTestId('insights-hero-total'))).toBeNull();
  expect(findAskButtonClearance(screen.getByTestId('insights-donut'))).toBeNull();
  expect(findAskButtonClearance(screen.getByTestId('insights-earned-spent'))).toBeNull();
});

it('[A6] Goals: the mortgage headline card stays full width; "Add a goal" sits in the gap', async () => {
  seedGoalsHub(server, {
    goals: [{ id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-12-15', account_id: 'up-spending' }],
    payCycle: PAY_CYCLE,
    balances: { 'up-spending': 4000 },
  });
  await renderWithApp(<Goals />);
  expectClearsAskButton(await screen.findByTestId('goal-card-g1'));
  expectClearsAskButton(screen.getByTestId('add-goal-cta'));
  expect(findAskButtonClearance(screen.getByTestId('mortgage-link'))).toBeNull();
});

// [A7] (P1) the Insights Earning side's income rows sit in the gap too.
it('[A7] Insights Earning side: income source rows sit in the gap', async () => {
  seedInsights(server, {
    breakdown: breakdownWire({ spend: { coffee: { posted: 40, pending: 0 } }, income: { salary: { posted: 3000, pending: 0 } } }),
    categories: [{ ...COFFEE, recent: 0 }, SALARY],
    payCycle: PAY_CYCLE,
  });
  await renderWithApp(<Insights />);
  fireEvent.press(await screen.findByTestId('insights-side-earning'));
  expectClearsAskButton(await screen.findByText('Salary'));
});

// [A8] (P1) Transactions: the segmented control/search stay full width; the plan puts Load More in the gap.
it('[A8] Transactions: rows and Load More sit in the gap', async () => {
  server.seed('/transactions/feed', { transactions: [LIST_ROW], nextCursor: 'c1' });
  await renderWithApp(<Transactions />);
  expectClearsAskButton(await screen.findByText('-$42.00'));
  expectClearsAskButton(await screen.findByTestId('transactions-load-more'));
});
