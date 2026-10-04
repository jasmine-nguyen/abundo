// WHIT-707 — the Budgets tab shows Spending and Earning sections, a one-line caption instead of
// the swatch legend, and an over-budget row's spread link opens the spread screen prefilled.
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { routerSpies, resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderBudgets } from './support/budgetsScreen';
import { COFFEE } from './support/categories';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => {
  resetRouter();
  server.seed('/paycycle', { length: 14, last_pay_date: '2026-07-01' });
  server.seed('/categories', [
    { id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#35d9a0', recent: 0 },
    COFFEE,
  ]);
  server.seed('/budgets', {
    salary: { target: 5000, posted: 1000, pending: 0 },
    coffee: { target: 100, posted: 120, pending: 0 }, // $20 over, no rollover → spreadable
  });
});

it('shows Spending and Earning sections, the caption, and a spread link that opens spread prefilled', async () => {
  renderBudgets();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();

  expect(screen.getByText('SPENDING')).toBeTruthy();
  expect(screen.getByText('EARNING')).toBeTruthy();
  expect(screen.getByText("Solid = spent · faded = pending · line = today's pace")).toBeTruthy();
  expect(screen.queryByText("Today's pace")).toBeNull();

  expect(screen.getByText('Spread it over pay cycles →')).toBeTruthy();
  fireEvent.press(screen.getByTestId('budget-row-spread-coffee'));
  expect(routerSpies.push).toHaveBeenCalledWith('/budget/spread?categoryId=coffee&prefill=20');
  expect(routerSpies.push).not.toHaveBeenCalledWith('/budget/coffee');
});
