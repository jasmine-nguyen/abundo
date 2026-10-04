// WHIT-730 follow-up — the floating Ask button sits over every tab. On all five tabs the list rows
// leave a right-hand gap for it, so even at rest it never covers a row's amount, bar or note.
// Real screens + ../queries + ../api over the fake server, inside the real AppProvider.
import { it, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { renderWithApp } from './support/renderWithApp';
import { LIST_ROW, resetListTabs } from './support/listTabsScreen';
import { seedBudgetsTab } from './support/budgetsTab';
import { seedGoalsHub } from './support/goalsScreen';
import { COFFEE, GROCERIES } from './support/categories';
import { expectClearsAskButton } from './support/askButtonClearance';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

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

const TABS: [string, () => void, React.ReactElement, string][] = [
  ['Budgets', () => seedBudgetsTab(server, { groceries: { target: 100, posted: 30, pending: 0 } }, [GROCERIES]), <Budgets />, 'Groceries'],
  ['Transactions', () => server.seed('/transactions/feed', { transactions: [LIST_ROW], nextCursor: null }), <Transactions />, '-$42.00'],
  ['Accounts', () => server.seed('/transactions/feed', { transactions: [LIST_ROW], nextCursor: null }), <Accounts />, 'ANZ'],
  ['Insights', () => {
    server.seed('/breakdown', { coffee: { posted: 40, pending: 0 } });
    server.seed('/categories', [{ ...COFFEE, recent: 0 }]);
    server.seed('/paycycle', PAY_CYCLE);
  }, <Insights />, 'Cafes & Coffee'],
  ['Goals', () => seedGoalsHub(server, {
    goals: [{ id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-12-15', account_id: 'up-spending' }],
    payCycle: PAY_CYCLE,
    balances: { 'up-spending': 4000 },
  }), <Goals />, 'Emergency fund'],
];

it.each(TABS)('%s: list rows leave a right-hand gap so the Ask button never covers them', async (_tab, seed, ui, rowText) => {
  seed();
  await renderWithApp(ui);
  expectClearsAskButton(await screen.findByText(rowText));
});
