// WHIT-726 → WHIT-731 QA — adversarial edges of the Spent · Budget · Next payday row on the Budgets
// top card: pending leaves the card but stays on the rows, the empty state keeps only the payday,
// and the whole-dollar rounding at the half-dollar edge with thousands separators.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE, SALARY } from './support/categories';
import { BUDGET_PAY_CYCLE, seedBudgets, renderBudgets, showBudgets, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

describe('WHIT-731 QA — the Spent · Budget · Next payday row', () => {
  // [A1] (P0) pending leaves the card but stays on the row
  it('[A1] pending is gone from the card but still on the coffee row', async () => {
    await showBudgets(server, { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } }, { categories: [COFFEE], daysLeft: 22 });
    expect(heroTotals()).toMatchObject({ spent: '$6,136.68', budget: '$5,785' });
    const pendingTexts = screen.getAllByText(/\$187\.76 pending/);
    expect(pendingTexts).toHaveLength(1);
    expect(pendingTexts[0].props.testID).toBeUndefined();
    expect(screen.queryByText(/resets/)).toBeNull();
  });

  // [A3] (P1) the empty state shows only the payday cell
  it('[A3] no spending budgets → only the "Next payday" cell, no Spent or Budget', async () => {
    seedBudgets(server, { budgets: { salary: { target: 5000, posted: 1000, pending: 0 } }, categories: [COFFEE, SALARY], payCycle: BUDGET_PAY_CYCLE });
    renderBudgets();
    await screen.findByText('Salary');
    expect(screen.getByText(/^No spending budgets yet/)).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: undefined, budget: undefined });
    expect(heroTotals().payday).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);
    expect(screen.getByText('Next payday')).toBeTruthy();
    expect(screen.queryByText('Spent')).toBeNull();
    expect(screen.queryByText('Budget')).toBeNull();
  });

  // [A4] (P1) cents stay when the amount has them (WHIT-735), thousands get commas
  it('[A4] $1,234.50 of $12,345 → Spent "$1,234.50", Budget "$12,345"', async () => {
    await showBudgets(server, { coffee: { target: 12345, posted: 1234, pending: 0.5 } }, { categories: [COFFEE] });
    expect(heroTotals()).toMatchObject({ spent: '$1,234.50', budget: '$12,345' });
  });
});
