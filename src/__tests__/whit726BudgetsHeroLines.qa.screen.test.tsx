// WHIT-726 QA — adversarial edges of the two quiet lines on the Budgets top card: pending leaves
// the card but stays on the rows, the lines are plain soft ink (no pill box) paired tightly, and
// the whole-dollar rounding at the half-dollar edge with thousands separators.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE, SALARY } from './support/categories';
import { BUDGET_PAY_CYCLE, seedBudgets, renderBudgets, showBudgets } from './support/budgetsScreen';
import { C } from '../theme';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

describe('WHIT-726 QA — the two quiet lines', () => {
  // [A1] (P0) pending leaves the card but stays on the row
  it('[A1] pending is gone from the card but still on the coffee row', async () => {
    await showBudgets(server, { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } }, { categories: [COFFEE], daysLeft: 22 });
    expect(screen.getByText('$6,137 / $5,785 spent')).toBeTruthy();
    const pendingTexts = screen.getAllByText(/\$187\.76 pending/);
    expect(pendingTexts).toHaveLength(1);
    expect(pendingTexts[0].props.testID).toBeUndefined();
    expect(screen.queryByText(/resets/)).toBeNull();
  });

  // [A2] (P1) plain soft ink, no box; payday sits tight under the spent line
  it('[A2] spent line is soft ink with no background; payday is tight under it', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 40, pending: 0 } }, { categories: [COFFEE] });
    const spent = StyleSheet.flatten(screen.getByTestId('budgets-hero-spent').props.style);
    expect(spent.color).toBe(C.heroInkSoft);
    expect(spent.backgroundColor).toBeUndefined();
    expect(spent.marginTop).toBe(16);
    const payday = StyleSheet.flatten(screen.getByTestId('budgets-hero-payday').props.style);
    expect(payday.color).toBe(C.heroInkSoft);
    expect(payday.marginTop).toBe(4);
  });

  // [A3] (P1) the empty state keeps today's payday spacing and has no spent line
  it('[A3] no spending budgets → no spent line, payday keeps its normal gap', async () => {
    seedBudgets(server, { budgets: { salary: { target: 5000, posted: 1000, pending: 0 } }, categories: [COFFEE, SALARY], payCycle: BUDGET_PAY_CYCLE });
    renderBudgets();
    await screen.findByText('Salary');
    expect(screen.getByText(/^No spending budgets yet/)).toBeTruthy();
    expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
    const payday = StyleSheet.flatten(screen.getByTestId('budgets-hero-payday').props.style);
    expect(payday.marginTop).toBe(10);
  });

  // [A4] (P1) half a dollar rounds up, thousands get commas
  it('[A4] $1,234.50 of $12,345 → "$1,235 / $12,345 spent"', async () => {
    await showBudgets(server, { coffee: { target: 12345, posted: 1234, pending: 0.5 } }, { categories: [COFFEE] });
    expect(screen.getByText('$1,235 / $12,345 spent')).toBeTruthy();
  });
});
