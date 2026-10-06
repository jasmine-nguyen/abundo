// WHIT-726 → WHIT-731 QA — adversarial edges of the Spent · Budget · Next payday row on the Budgets
// top card: pending is gone from the card and the rows (WHIT-744), the empty state keeps only the payday,
// and the whole-dollar rounding at the half-dollar edge with thousands separators.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE } from './support/categories';
import { showBudgets, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

describe('WHIT-731 QA — the Spent · Budget · Next payday row', () => {
  // [A1] (P0) pending is gone from the card and from the row (WHIT-744)
  it('[A1] pending is gone from both the card and the coffee row (WHIT-744)', async () => {
    await showBudgets(server, { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } }, { categories: [COFFEE], daysLeft: 22 });
    expect(heroTotals()).toMatchObject({ spent: '$6,136.68', budget: '$5,785' });
    expect(screen.queryByText(/pending/)).toBeNull();
    expect(screen.queryByText(/resets/)).toBeNull();
  });

  // [A4] (P1) cents stay when the amount has them (WHIT-735), thousands get commas
  it('[A4] $1,234.50 of $12,345 → Spent "$1,234.50", Budget "$12,345"', async () => {
    await showBudgets(server, { coffee: { target: 12345, posted: 1234, pending: 0.5 } }, { categories: [COFFEE] });
    expect(heroTotals()).toMatchObject({ spent: '$1,234.50', budget: '$12,345' });
  });
});
