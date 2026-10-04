// WHIT-716 QA — adversarial edges of the Budgets top card: spend summed across rows (spend only,
// once per family, pending included), the 0.005 over cut-off on its exact edge, the spent line in
// whole dollars (WHIT-726: "$X / $Y spent"), and float dust in the summed cents.
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

describe('WHIT-716 QA — spent line totals', () => {
  // [A1] (P0) posted + pending from several rows sums into the spent line, rounded to whole dollars
  it('[A1] sums posted + pending across spending rows: $39.75 → "$40 / $150 spent"', async () => {
    await showBudgets(server, {
      coffee: { target: 100, posted: 20, pending: 10.5 },
      groceries: { target: 50, posted: 5, pending: 4.25 },
    });
    expect(screen.getByText('$40 / $150 spent')).toBeTruthy();
  });

  // [A2] (P0) Income and Savings never reach the spent line
  it('[A2] Income and Savings stay out of the spent line', async () => {
    await showBudgets(
      server,
      {
        coffee: { target: 100, posted: 50, pending: 0 },
        salary: { target: 5000, posted: 1000, pending: 300 },
        rainy: { target: 300, posted: 100, pending: 70 },
      },
      { categories: [COFFEE, SALARY, SAVINGS] },
    );
    expect(screen.getByText('$50 / $100 spent')).toBeTruthy();
  });

  // [A3] (P0) a budgeted sub's spend is already in its parent's rollup → counted once
  it('[A3] a budgeted sub under a budgeted parent does not double-count', async () => {
    await showBudgets(
      server,
      {
        coffee: { target: 100, posted: 0, pending: 0 },
        car: { target: 200, posted: 60, pending: 15 },
        parking: { target: 50, posted: 20, pending: 10 },
      },
      { categories: [COFFEE, CAR, PARKING] },
    );
    expect(screen.getByText('$75 / $300 spent')).toBeTruthy();
  });
});

describe('WHIT-716 QA — money format', () => {
  // [A5] (P0) the spent line stays whole dollars, even with rollover cents
  it('[A5] rollover cents: spent line "$50 / $100 spent", big number "$50"', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 50.4, pending: 0, rollover: true, carryover: 0.4 } }, { categories: [COFFEE] });
    expect(screen.getByText('$50 / $100 spent')).toBeTruthy();
    expect(screen.getAllByText('$50')).toHaveLength(2); // card + the row's left
    expect(screen.getByText('Left to spend')).toBeTruthy();
  });

  // [A6] (P1) summed float cents (0.1 + 0.2) render cleanly, not 0.30000000000000004
  it('[A6] float dust in summed cents: "$0 / $100 spent", left "$99.70"', async () => {
    await showBudgets(server, {
      coffee: { target: 50, posted: 0.1, pending: 0 },
      groceries: { target: 50, posted: 0.2, pending: 0 },
    });
    expect(screen.getByText('$0 / $100 spent')).toBeTruthy();
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
  // [A8] (P0) half a cent over is float dust → calm, no minus; the cut-off is strict
  it('[A8] half a cent over stays "Left to spend" (incl. exactly -0.005)', async () => {
    const first = await showBudgets(server, { coffee: { target: 100, posted: 100, pending: 0.005 } }, { categories: [COFFEE] });
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
    expect(screen.queryAllByText(/−/)).toHaveLength(0);
    first.unmount();

    // 0.005 - 0.01 is exactly -0.005 in floating point: the strict `<` keeps it calm.
    await showBudgets(server, { coffee: { target: 0.005, posted: 0.01, pending: 0 } }, { categories: [COFFEE] });
    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(screen.queryByText('Over budget')).toBeNull();
  });

  // [A10] (P1) over budget with pending: the spent line includes it, overspend amount said once
  it('[A10] over with pending → "−$20.50" once, spent line "$121 / $100 spent"', async () => {
    await showBudgets(server, { coffee: { target: 100, posted: 90, pending: 30.5 } }, { categories: [COFFEE] });
    expect(screen.getAllByText('−$20.50')).toHaveLength(1);
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(screen.getByText('$121 / $100 spent')).toBeTruthy();
  });
});
