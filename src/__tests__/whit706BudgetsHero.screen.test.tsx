// WHIT-706: the Budgets top card (hero) — first-time screen, days + money side by side, next
// payday, and an over-budget next step. Real useBudgetsScreenData over the fake server; ../auth +
// expo-router mocked; rendered under a real QueryClientProvider.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { routerSpies, resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { pinToday } from './support/clock';
import { seedBudgets, renderBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
const MINUS = '−';

beforeEach(() => {
  seedBudgets(server, { payCycle: { length: 30, last_pay_date: '2026-07-01', days_left: 4 } });
  resetRouter();
});

describe('Budgets top card', () => {
  it('no budgets → days left stays, money part is replaced by one "Add your first budget" button', async () => {
    server.seed('/budgets', {});
    renderBudgets();
    expect(await screen.findByText('Add your first budget')).toBeTruthy();
    expect(screen.getByText('days left')).toBeTruthy();
    expect(screen.queryByText('Budget remaining')).toBeNull();
    expect(screen.queryByText('Left to spend')).toBeNull();
    expect(screen.queryByText('Over budget')).toBeNull();
    expect(screen.queryByText('of $0')).toBeNull();
    expect(screen.queryByText("Solid = spent · faded = pending · line = today's pace")).toBeNull(); // caption hidden
    expect(screen.queryByText('Add a budget')).toBeNull();  // the duplicate dashed button is hidden
    fireEvent.press(screen.getByTestId('budgets-hero-add'));
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
  });

  it('under budget → "Left to spend", no over-budget line', async () => {
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.getByText('days left')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
    expect(screen.queryByText(/^Over by /)).toBeNull();
    expect(screen.queryByText('Budget remaining')).toBeNull();
  });

  it('over budget → real minus sign and "Over by $X · resets in N days"', async () => {
    server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText(`${MINUS}$100`)).toBeTruthy();
    expect(screen.queryByText('-$100')).toBeNull();
    expect(screen.getByText('Over by $100 · resets in 4 days')).toBeTruthy();
  });

  it('1 day left → singular "day left" and "resets in 1 day"', async () => {
    server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: 1 });
    server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('day left')).toBeTruthy();
    expect(screen.queryByText('days left')).toBeNull();
    expect(screen.getByText('Over by $100 · resets in 1 day')).toBeTruthy();
  });

  it('0 days left and over → "resets today"', async () => {
    server.seed('/paycycle', { length: 30, last_pay_date: '2026-07-01', days_left: 0 });
    server.seed('/budgets', { coffee: { target: 100, posted: 200, pending: 0 } });
    renderBudgets();
    await screen.findByText('Cafes & Coffee');
    expect(screen.getByText('Over by $100 · resets today')).toBeTruthy();
  });

  it('shows the next payday date instead of the cycle start', async () => {
    pinToday(new Date('2026-09-18T10:00:00+10:00')); // 18 Sep 2026, Melbourne
    try {
      // last payday 1 Sep, 30-day cycle → next payday 1 Oct
      server.seed('/paycycle', { length: 30, last_pay_date: '2026-09-01' });
      renderBudgets();
      expect(await screen.findByText('Next payday 1 Oct')).toBeTruthy();
      expect(screen.queryByText(/^Started /)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
