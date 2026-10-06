// WHIT-707 — the Budgets tab shows Spending and Earning sections with no swatch legend.
// Real ../api over the fake server; ../auth + expo-router mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { renderLoadedBudgets } from './support/budgetsScreen';
import { COFFEE } from './support/categories';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => {
  resetRouter();
  server.seed('/paycycle', { length: 14, last_pay_date: '2026-07-01' });
  server.seed('/categories', [
    { id: 'salary', name: 'Salary', bucket: 'Income', icon: 'briefcase', color: '#35d9a0' },
    COFFEE,
  ]);
  server.seed('/budgets', {
    salary: { target: 5000, posted: 1000, pending: 0 },
    coffee: { target: 100, posted: 120, pending: 0 }, // $20 over
  });
});

it('shows Spending and Earning sections', async () => {
  await renderLoadedBudgets();

  expect(screen.getByText('SPENDING')).toBeTruthy();
  expect(screen.getByText('EARNING')).toBeTruthy();
  expect(screen.queryByText("Today's pace")).toBeNull();
});
