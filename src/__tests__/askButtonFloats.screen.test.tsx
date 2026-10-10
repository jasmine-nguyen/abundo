// Checks across the tabs that need the default screen setup: real screens + ../queries + ../api
// over the fake server, inside the real AppProvider, with no large-text mock of their own.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';
import { seedBudgetsTab } from './support/budgetsTab';
import { seedGoalsHub } from './support/goalsScreen';
import { rightOnlyGaps } from './support/budgetsScreen';
import { COFFEE, GROCERIES } from './support/categories';

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
});
