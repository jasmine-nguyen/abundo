// WHIT-716 — the Budgets top card: the overspend said once ("−$X" + "Over budget"), the big number
// in the rows' cents format, and "Over budget" from 1 cent over. The Spent and Budget
// values use the same format (WHIT-735). Real useBudgetsScreenData over the fake server.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { showBudgets, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

describe('WHIT-716 Budgets top card spent line + over line', () => {
  it('over budget → "−$100" and "Over budget", the amount not repeated', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 200, pending: 0 } });
    expect(screen.getByText('−$100')).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.queryByText(/Over by/)).toBeNull();
  });

  it('big number and Spent keep cents like the rows ("$66.25"; "$83.75" of "$150")', async () => {
    await showBudgets(server, {
      coffee: { target: 100, posted: 73.5, pending: 0 },
      groceries: { target: 50, posted: 10.25, pending: 0 },
    });
    expect(screen.getByText('$66.25')).toBeTruthy();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$83.75', budget: '$150' });
  });

  it('30 cents over → "−$0.30" and "Over budget", never "Left to spend"', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 100.3, pending: 0 } });
    expect(screen.getByText('−$0.30')).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.queryByText('Left to spend')).toBeNull();
  });
});
