// WHIT-737 QA — the spots the five-tab test skips: Load More, "Add a goal" and the Insights
// Earning rows also run full width, with no right-hand lane above them.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';
import { seedGoalsHub } from './support/goalsScreen';
import { breakdownWire, seedInsights } from './support/insightsScreen';
import { rightOnlyGaps } from './support/budgetsScreen';
import { COFFEE, SALARY } from './support/categories';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Transactions from '../../app/(tabs)/transactions';
import Insights from '../../app/(tabs)/insights';
import Goals from '../../app/(tabs)/goals';

const server = installFakeServer();
useTestQueryClient();

const PAY_CYCLE = { length: 14, last_pay_date: '2026-09-12' };

beforeEach(() => {
  resetListTabs(server);
});

// [A1] (P1) Transactions: Load More runs full width.
it('[A1] Transactions: Load More has no right-hand lane above it', async () => {
  server.seed('/transactions/feed', { transactions: [LIST_ROW], nextCursor: 'c1' });
  await renderWithApp(<Transactions />);
  expect(rightOnlyGaps(await screen.findByTestId('transactions-load-more'))).toEqual([]);
});

// [A2] (P1) Goals: "Add a goal" runs full width.
it('[A2] Goals: "Add a goal" has no right-hand lane above it', async () => {
  seedGoalsHub(server, {
    goals: [{ id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-12-15', account_id: 'up-spending' }],
    payCycle: PAY_CYCLE,
    balances: { 'up-spending': 4000 },
  });
  await renderWithApp(<Goals />);
  expect(rightOnlyGaps(await screen.findByTestId('add-goal-cta'))).toEqual([]);
});

// [A3] (P1) Insights Earning side: income rows run full width.
it('[A3] Insights Earning side: income rows have no right-hand lane above them', async () => {
  seedInsights(server, {
    breakdown: breakdownWire({ spend: { coffee: { posted: 40, pending: 0 } }, income: { salary: { posted: 3000, pending: 0 } } }),
    categories: [{ ...COFFEE }, SALARY],
    payCycle: PAY_CYCLE,
  });
  await renderWithApp(<Insights />);
  fireEvent.press(await screen.findByTestId('insights-side-earning'));
  expect(rightOnlyGaps(await screen.findByText('Salary'))).toEqual([]);
});
