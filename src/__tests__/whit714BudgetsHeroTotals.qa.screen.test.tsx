// WHIT-714 QA: adversarial edges for the Budgets top card with no spending rows and while loading.
// Real useBudgetsScreenData over the fake server; ../auth + expo-router mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { refreshInAct } from './support/renderWithQueries';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE, SALARY, SAVINGS } from './support/categories';
import { BUDGET_PAY_CYCLE, seedBudgets, renderBudgets, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
const NO_SPENDING = /^No spending budgets yet/;

beforeEach(() => {
  seedBudgets(server, { categories: [COFFEE, SALARY, SAVINGS], payCycle: { ...BUDGET_PAY_CYCLE, days_left: 4 } });
  resetRouter();
});

describe('WHIT-714 top card — QA edges', () => {
  // [A1] (P0) income + Savings, no spending → no money figures at all, no first-time button
  it('[A1] income + Savings budgets → no "$" on the top card, honest wording, dashed add kept', async () => {
    server.seed('/budgets', {
      salary: { target: 5000, posted: 1000, pending: 0 },
      rainy: { target: 300, posted: 100, pending: 0 },
    });
    renderBudgets();
    await screen.findByText('Salary');
    expect(screen.getByText(NO_SPENDING)).toBeTruthy();
    expect(screen.queryByText('Left to spend')).toBeNull();
    expect(screen.queryByTestId('budgets-hero-spent')).toBeNull();
    expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
    expect(screen.queryByText('Rainy Day')).toBeNull(); // Savings stays hidden (WHIT-201)
    expect(screen.getByText('Add a budget')).toBeTruthy();
  });

  // [A2] (P0) income-only → a spending budget is added on refetch → the money view replaces the empty wording
  it('[A2] income-only → spending budget appears on refetch → money column back, empty wording gone', async () => {
    server.seed('/budgets', { salary: { target: 5000, posted: 1000, pending: 0 } });
    const { client } = renderBudgets();
    await screen.findByText(NO_SPENDING);
    server.seed('/budgets', {
      salary: { target: 5000, posted: 1000, pending: 0 },
      coffee: { target: 100, posted: 40, pending: 10 },
    });
    await refreshInAct(() => client.invalidateQueries({ queryKey: ['budgets'] }));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByText(NO_SPENDING)).toBeNull();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$50', budget: '$100' });
  });

  // [A3] (P1) budgets loaded but categories still loading → days-only card + spinner, never the
  // "No spending budgets yet" prompt (rows are empty only because categories haven't arrived)
  it('[A3] categories still loading → days-only card, no false empty prompt', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 40, pending: 10 } });
    const held = server.hold('/categories');
    renderBudgets();
    expect(await screen.findByText('days left')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByTestId('budgets-loading')).toBeTruthy();
    expect(screen.queryByText(NO_SPENDING)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-add')).toBeNull();
    held.release();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  });

  // [A4] (P1) pay cycle fails while budgets are still loading → error card, never a days card from the default cycle
  it('[A4] pay cycle fails while budgets load → error view, no days-left card', async () => {
    server.fail('/paycycle', 500);
    server.hold('/budgets');
    renderBudgets();
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.queryByText(/days? left/)).toBeNull();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });
});
