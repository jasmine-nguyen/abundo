// Checks across the tabs that need the default screen setup: real screens + ../queries + ../api
// over the fake server, inside the real AppProvider, with no large-text mock of their own.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';
import { seedBudgetsTab } from './support/budgetsTab';
import { seedGoalsHub } from './support/goalsScreen';
import { breakdownWire, seedInsights } from './support/insightsScreen';
import { rightOnlyGaps, showTwoRows } from './support/budgetsScreen';
import { COFFEE, GROCERIES, SALARY } from './support/categories';
import { styleOf, sharedHost } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Budgets from '../../app/(tabs)/budgets';
import Transactions from '../../app/(tabs)/transactions';
import Accounts from '../../app/(tabs)/accounts';
import Insights from '../../app/(tabs)/insights';
import Goals from '../../app/(tabs)/goals';

const server = installFakeServer();
useTestQueryClient();

const PAY_CYCLE = { length: 14, last_pay_date: '2026-09-12' };

beforeEach(() => {
  resetListTabs(server);
});

describe('WHIT-737 the Ask button floats', () => {
  // WHIT-737 — the Ask button floats over the content again. On all five tabs no wrapper above a
  // list row pads the right side more than the left, so cards run full width (no right-hand lane).
  const TABS: [string, () => void, React.ReactElement, string][] = [
    ['Budgets', () => seedBudgetsTab(server, { groceries: { target: 100, posted: 30, pending: 0 } }, [GROCERIES]), <Budgets />, 'Groceries'],
    ['Transactions', () => server.seed('/transactions/feed', { transactions: [LIST_ROW], nextCursor: null }), <Transactions />, '-$42.00'],
    ['Accounts', () => server.seed('/transactions/feed', { transactions: [LIST_ROW], nextCursor: null }), <Accounts />, 'ANZ'],
    ['Insights', () => {
      server.seed('/breakdown', { coffee: { posted: 40, pending: 0 } });
      server.seed('/categories', [{ ...COFFEE }]);
      server.seed('/paycycle', PAY_CYCLE);
    }, <Insights />, 'Cafes & Coffee'],
    ['Goals', () => seedGoalsHub(server, {
      goals: [{ id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-12-15', account_id: 'up-spending' }],
      payCycle: PAY_CYCLE,
      balances: { 'up-spending': 4000 },
    }), <Goals />, 'Emergency fund'],
  ];

  it.each(TABS)('%s: no wrapper above a list row leaves a right-hand lane for the Ask button', async (_tab, seed, ui, rowText) => {
    seed();
    await renderWithApp(ui);
    expect(rightOnlyGaps(await screen.findByText(rowText))).toEqual([]);
  });

  // WHIT-737 QA — the spots the five-tab test skips: Load More, "Add a goal" and the Insights
  // Earning rows also run full width, with no right-hand lane above them.

  // [A1] (P1) Transactions: Load More runs full width.
  it('[A1] Transactions: Load More has no right-hand lane above it', async () => {
    server.seed('/transactions/feed', { transactions: [LIST_ROW], nextCursor: 'c1' });
    await renderWithApp(<Transactions />);
    expect(rightOnlyGaps(await screen.findByTestId('transactions-load-more'))).toEqual([]);
  });

  // [A2] (P1) Goals: "Add a goal" runs full width. It shows only with no goals (WHIT-814).
  it('[A2] Goals: "Add a goal" has no right-hand lane above it', async () => {
    seedGoalsHub(server, { goals: [], payCycle: PAY_CYCLE });
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
});

describe('WHIT-743 default text layout', () => {
  // WHIT-743 QA — with no per-file mock, screen tests must still draw the normal (side-by-side)
  // Budgets layout. The test renderer reports fontScale 2, so this fails if jest.setup.js stops
  // defaulting useLargeText to false. It lives here, not in budgetsTab.screen.test.tsx, because
  // that file mocks useLargeText itself.
  it('by default the Budgets row and top card stay side by side', async () => {
    await showTwoRows(server);
    const row = within(screen.getByTestId('budget-row-coffee'));
    expect(styleOf(sharedHost(row.getByText('Cafes & Coffee'), row.getByText('$20'))).flexDirection).toBe('row');
    expect(styleOf(sharedHost(screen.getByText('7'), screen.getByText('$95'))).flexDirection).toBe('row');
  });
});
