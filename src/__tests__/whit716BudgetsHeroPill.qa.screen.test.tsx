// WHIT-716 QA — adversarial edges of the Budgets top card: pending summed across rows (spend
// only, once per family), the 0.005 pending and over cut-offs on their exact edges, the "of"
// total staying whole dollars, float dust in the summed cents, and the over line per days left.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE, SALARY, SAVINGS } from './support/categories';
import { showBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

const CAR = { id: 'car', name: 'Car', bucket: 'Living', icon: 'car', color: '#8AB4F8', recent: 0, parent: null };
const PARKING = { id: 'parking', name: 'Parking', bucket: 'Living', icon: 'car', color: '#8AB4F8', recent: 0, parent: 'car' };

beforeEach(() => resetRouter());

describe('WHIT-716 QA — pill pending', () => {
  // [A1] (P0) pending from several rows sums, in the rows' cents format
  it('[A1] sums pending across spending rows with cents: "$14.75 pending"', async () => {
    await showBudgets(server, {
      coffee: { target: 100, posted: 20, pending: 10.5 },
      groceries: { target: 50, posted: 5, pending: 4.25 },
    });
    expect(screen.getByText('$39.75 spent of $150 · $14.75 pending')).toBeTruthy();
  });

  // [A2] (P0) Income and Savings pending never reach the pill
  it('[A2] Income and Savings pending stay out of the pill', async () => {
    await showBudgets(
      server,
      {
        coffee: { target: 100, posted: 50, pending: 0 },
        salary: { target: 5000, posted: 1000, pending: 300 },
        rainy: { target: 300, posted: 100, pending: 70 },
      },
      { categories: [COFFEE, SALARY, SAVINGS] },
    );
    expect(screen.getByText('$50 spent of $100')).toBeTruthy();
    expect(screen.queryByText(/spent of .*pending/)).toBeNull();
  });

  // [A3] (P0) a budgeted sub's pending is already in its parent's rollup → counted once
  it('[A3] a budgeted sub under a budgeted parent does not double-count pending', async () => {
    await showBudgets(
      server,
      {
        coffee: { target: 100, posted: 0, pending: 0 },
        car: { target: 200, posted: 60, pending: 15 },
        parking: { target: 50, posted: 20, pending: 10 },
      },
      { categories: [COFFEE, CAR, PARKING] },
    );
    expect(screen.getByText('$75 spent of $300 · $15 pending')).toBeTruthy();
    expect(screen.queryByText(/\$25 pending$/)).toBeNull();
  });

  // [A4] (P1) the pending cut-off is strict: exactly 0.005 hides, 0.006 shows "$0.01 pending"
  it('[A4] pending exactly 0.005 is hidden; 0.006 shows as "$0.01 pending"', async () => {
    const first = await showBudgets(server, { coffee: { target: 100, posted: 50, pending: 0.005 } });
    expect(screen.queryByText(/spent of .*pending/)).toBeNull();
    first.unmount();

    await showBudgets(server, { coffee: { target: 100, posted: 50, pending: 0.006 } });
    expect(screen.getByText(/spent of \$100 · \$0\.01 pending$/)).toBeTruthy();
  });
});

describe('WHIT-716 QA — money format', () => {
  // [A5] (P0) "of" total stays whole dollars like the rows, even with rollover cents
  it('[A5] rollover cents: pill "$50.40 spent of $100", big number "$50"', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 50.4, pending: 0, rollover: true, carryover: 0.4 } }, { categories: [COFFEE] });
    expect(screen.getByText('$50.40 spent of $100')).toBeTruthy();
    expect(screen.getAllByText('$50')).toHaveLength(2); // card + the row's left
    expect(screen.getByText('Left to spend')).toBeTruthy();
  });

  // [A6] (P1) summed float cents (0.1 + 0.2) render as clean cents, not 0.30000000000000004
  it('[A6] float dust in summed cents: "$0.30 spent of $100", left "$99.70"', async () => {
    await showBudgets(server, {
      coffee: { target: 50, posted: 0.1, pending: 0 },
      groceries: { target: 50, posted: 0.2, pending: 0 },
    });
    expect(screen.getByText('$0.30 spent of $100')).toBeTruthy();
    expect(screen.getByText('$99.70')).toBeTruthy();
  });

  // [A7] (P0) the card's left equals the rows' lefts added up (both in cents)
  it('[A7] card left matches the rows: $26.50 + $39.75 = $66.25', async () => {
    await showBudgets(server, {
      coffee: { target: 100, posted: 70, pending: 3.5 },
      groceries: { target: 50, posted: 10.25, pending: 0 },
    });
    expect(screen.getByText('$26.50')).toBeTruthy();
    expect(screen.getByText('$39.75')).toBeTruthy();
    expect(screen.getByText('$66.25')).toBeTruthy();
  });
});

describe('WHIT-716 QA — over line', () => {
  // [A8] (P0) half a cent over is float dust → calm, no minus, no resets line; the cut-off is strict
  it('[A8] half a cent over stays "Left to spend" with no resets line (incl. exactly -0.005)', async () => {
    const first = await showBudgets(server, { coffee: { target: 100, posted: 100, pending: 0.005 } }, { categories: [COFFEE] });
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
    expect(screen.queryByText(/^resets /)).toBeNull();
    expect(screen.queryAllByText(/−/)).toHaveLength(0);
    first.unmount();

    // 0.005 - 0.01 is exactly -0.005 in floating point: the strict `<` keeps it calm.
    await showBudgets(server, { coffee: { target: 0.005, posted: 0.01, pending: 0 } }, { categories: [COFFEE] });
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
  });

  // [A9] (P1) the over line is just the resets wording, for 1 day and for today
  it('[A9] over with 1 day left → "resets in 1 day"; 0 days → "resets today"', async () => {
    const first = await showBudgets(server, { coffee: { target: 100, posted: 150, pending: 0 } }, { categories: [COFFEE], daysLeft: 1 });
    expect(screen.getByText('resets in 1 day')).toBeTruthy();
    expect(screen.queryByText(/Over by/)).toBeNull();
    first.unmount();

    await showBudgets(server, { coffee: { target: 100, posted: 150, pending: 0 } }, { categories: [COFFEE], daysLeft: 0 });
    expect(screen.getByText('resets today')).toBeTruthy();
    expect(screen.queryByText(/Over by/)).toBeNull();
  });

  // [A10] (P1) over budget with pending: pill still names it, overspend amount said once
  it('[A10] over with pending → "−$20.50" once, pill "$120.50 spent of $100 · $30.50 pending"', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 90, pending: 30.5 } }, { categories: [COFFEE] });
    expect(screen.getAllByText('−$20.50')).toHaveLength(1);
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText('$120.50 spent of $100 · $30.50 pending')).toBeTruthy();
    expect(screen.getByText('resets in 4 days')).toBeTruthy();
  });

  // [A11] (P1) under budget never shows the resets line
  it('[A11] under budget shows no resets line', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 40, pending: 0 } }, { categories: [COFFEE] });
    expect(screen.queryByText(/^resets /)).toBeNull();
  });
});
