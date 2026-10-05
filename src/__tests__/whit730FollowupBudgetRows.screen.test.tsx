// WHIT-730 follow-up — on the Budgets tab, a slim $0 row lines up with the full rows (same
// left/right padding), and no row shows an "over plan" line (WHIT-744).
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { COFFEE, GROCERIES, DINING } from './support/categories';
import { seedBudgetsTab } from './support/budgetsTab';
import { renderLoadedBudgetsWithQueries, sidePadding } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  resetAuth();
});

it('a slim $0 budget row lines up with full rows, and no row shows "over plan"', async () => {
  // Halfway through a 14-day cycle: a $100 budget's pace target is $50.
  seedBudgetsTab(server, {
    coffee: { target: 100, posted: 0, pending: 0 },
    groceries: { target: 100, posted: 30, pending: 0 },
    dining: { target: 100, posted: 80, pending: 0 },
  }, [COFFEE, GROCERIES, DINING]);
  await renderLoadedBudgetsWithQueries();
  await screen.findByText('Groceries');

  expect(sidePadding('budget-row-coffee')).toEqual({ left: 16, right: 16 });
  expect(sidePadding('budget-row-groceries')).toEqual({ left: 16, right: 16 });

  expect(screen.queryByText(/over plan/)).toBeNull();
});
