// WHIT-714 — the Budgets top card must tell the truth when there are no spending budgets
// (income-only, Savings-only) and while budgets are still loading. Real useBudgetsScreenData
// over the fake server; ../auth + expo-router mocked; the shared query provider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE, SALARY, SAVINGS } from './support/categories';
import { BUDGET_PAY_CYCLE, BUDGETS_CAPTION, seedBudgets, renderBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

const NO_SPENDING = /^No spending budgets yet/;

beforeEach(() => {
  seedBudgets(server, { categories: [COFFEE, SALARY, SAVINGS], payCycle: { ...BUDGET_PAY_CYCLE, days_left: 4 } });
  resetRouter();
});

describe('WHIT-714 Budgets top card totals', () => {
  it('income-only budgets → no "$0 Left to spend" money column, honest empty wording', async () => {
    server.seed('/budgets', { salary: { target: 5000, posted: 1000, pending: 0 } });
    renderBudgets();
    await screen.findByText('Salary');
    expect(screen.queryByText('Left to spend')).toBeNull();
    expect(screen.queryByText(/spent of/)).toBeNull();
    expect(screen.getByText(NO_SPENDING)).toBeTruthy();
    expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
    expect(screen.getByText('Add a budget')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('days left')).toBeTruthy();
  });

  it('income-only over target → no "Over" text on the top card', async () => {
    server.seed('/budgets', { salary: { target: 1000, posted: 5000, pending: 0 } });
    renderBudgets();
    await screen.findByText('Salary');
    expect(screen.queryByText('Over budget')).toBeNull();
    expect(screen.queryByText(/^resets /)).toBeNull();
  });

  it('Savings-only budgets → not "No budgets yet"; offers "Add a spending budget"', async () => {
    server.seed('/budgets', { rainy: { target: 300, posted: 100, pending: 0 } });
    renderBudgets();
    expect(await screen.findByText(NO_SPENDING)).toBeTruthy();
    expect(screen.queryByText(/No budgets yet/)).toBeNull();
    expect(screen.getByText('Add a spending budget')).toBeTruthy();
    expect(screen.getByTestId('budgets-hero-add')).toBeTruthy();
    expect(screen.queryByText(BUDGETS_CAPTION)).toBeNull();
    expect(screen.queryByText('Add a budget')).toBeNull();
  });

  it('mixed spending + income + Savings → money view from spending rows only', async () => {
    server.seed('/budgets', {
      coffee: { target: 100, posted: 40, pending: 10 },
      salary: { target: 5000, posted: 1000, pending: 0 },
      rainy: { target: 300, posted: 100, pending: 0 },
    });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.getByText('$50 spent of $100 · $10 pending')).toBeTruthy();
    expect(screen.queryByText(NO_SPENDING)).toBeNull();
  });

  it('while budgets load with the pay cycle ready → a days-only top card above the spinner', async () => {
    const held = server.hold('/budgets');
    renderBudgets();
    expect(await screen.findByText('days left')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText(/^Next payday /)).toBeTruthy();
    expect(screen.getByTestId('budgets-loading')).toBeTruthy();
    expect(screen.queryByText('Left to spend')).toBeNull();
    expect(screen.queryByText(NO_SPENDING)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
    held.release();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });

  it('while the pay cycle is still loading → spinner only, never the default cycle count', async () => {
    const heldPayCycle = server.hold('/paycycle');
    const heldBudgets = server.hold('/budgets');
    renderBudgets();
    await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('budgets-loading')).toBeTruthy();
    expect(screen.queryByText(/days? left/)).toBeNull();
    heldPayCycle.release();
    heldBudgets.release();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  });
});
