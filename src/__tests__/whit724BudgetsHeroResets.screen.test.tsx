// WHIT-724 — Budgets top card: the legend caption is gone. (The reset line it also guarded was
// removed in WHIT-726; the card's two lines are covered by whit726BudgetsHeroLines.)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE } from './support/categories';
import { BUDGET_PAY_CYCLE, seedBudgets, renderLoadedBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => {
  seedBudgets(server, {
    budgets: { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } },
    categories: [COFFEE],
    payCycle: { ...BUDGET_PAY_CYCLE, days_left: 22 },
  });
  resetRouter();
});

describe('WHIT-724 Budgets top card', () => {
  it('the legend caption is gone', async () => {
    await renderLoadedBudgets();
    expect(screen.queryByText(/Solid = spent/)).toBeNull();
    expect(screen.queryByText(/faded = pending/)).toBeNull();
  });
});
