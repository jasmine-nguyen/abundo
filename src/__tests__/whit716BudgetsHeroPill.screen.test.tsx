// WHIT-716 — the Budgets top card: one pill "$X spent of $Y · $Z pending", the overspend said
// once ("−$X" + "Over budget" + "resets in N days"), amounts in the rows' cents format, and
// "Over budget" from 1 cent over. Real useBudgetsScreenData over the fake server.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { showBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

beforeEach(() => resetRouter());

describe('WHIT-716 Budgets top card pill + over line', () => {
  it('pill reads "$X spent of $Y · $Z pending", and drops the pending part at 0 and below a cent', async () => {
    const first = await showBudgets(server, { coffee: { target: 100, posted: 40, pending: 10 } });
    expect(screen.getByText('$50 spent of $100 · $10 pending')).toBeTruthy();
    expect(screen.queryByText('of $100')).toBeNull();
    expect(screen.queryByText('$50 spent')).toBeNull();
    first.unmount();

    const second = await showBudgets(server, { coffee: { target: 100, posted: 50, pending: 0 } });
    expect(screen.getByText('$50 spent of $100')).toBeTruthy();
    second.unmount();

    await showBudgets(server, { coffee: { target: 100, posted: 50, pending: 0.004 } });
    expect(screen.getByText('$50 spent of $100')).toBeTruthy();
    expect(screen.queryByText(/spent of .* pending/)).toBeNull();
  });

  it('over budget → "−$100", "Over budget" and "resets in 4 days", the amount not repeated', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 200, pending: 0 } });
    expect(screen.getByText('−$100')).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText('resets in 4 days')).toBeTruthy();
    expect(screen.queryByText(/Over by/)).toBeNull();
  });

  it('shows cents like the rows: left "$66.25", pill "$83.75 spent of $150"', async () => {
    await showBudgets(server, {
      coffee: { target: 100, posted: 73.5, pending: 0 },
      groceries: { target: 50, posted: 10.25, pending: 0 },
    });
    expect(screen.getByText('$66.25')).toBeTruthy();
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.getByText('$83.75 spent of $150')).toBeTruthy();
  });

  it('30 cents over → "−$0.30" and "Over budget", never "Left to spend"', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 100.3, pending: 0 } });
    expect(screen.getByText('−$0.30')).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.queryByText('Left to spend')).toBeNull();
  });
});
