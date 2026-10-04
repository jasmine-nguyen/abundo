// WHIT-726 — Budgets top card: the pill is replaced by two quiet lines, "$X / $Y spent" (whole
// dollars, pending included) then "Next payday …". No "resets in" and no pending on the card.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE } from './support/categories';
import { BUDGET_PAY_CYCLE, seedBudgets, renderLoadedBudgets } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

function seedCoffee(coffee: { target: number; posted: number; pending?: number }) {
  seedBudgets(server, {
    budgets: { coffee },
    categories: [COFFEE],
    payCycle: { ...BUDGET_PAY_CYCLE, days_left: 22 },
  });
}

function heroOf(node: ReactTestInstance): ReactTestInstance {
  let parent = node.parent;
  while (parent && String(parent.type) !== 'View') parent = parent.parent;
  if (!parent) throw new Error('no host View above the spent line');
  return parent;
}

function heroLineIds(hero: ReactTestInstance) {
  return within(hero).getAllByText(/ spent$|^Next payday /).map((line) => line.props.testID);
}

beforeEach(() => resetRouter());

describe('WHIT-726 Budgets top card: two quiet lines', () => {
  it('over budget → "$6,137 / $5,785 spent" then "Next payday", with no resets or pending on the card', async () => {
    seedCoffee({ target: 5785, posted: 5948.92, pending: 187.76 });
    await renderLoadedBudgets();

    // 5948.92 posted + 187.76 pending − 5785 budget = 351.68 over (the big number keeps its cents).
    expect(screen.getByText('−$351.68')).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();

    const spent = screen.getByTestId('budgets-hero-spent');
    expect(screen.getByText('$6,137 / $5,785 spent')).toBe(spent);
    expect(screen.getByText(/^Next payday /)).toBe(screen.getByTestId('budgets-hero-payday'));

    const hero = heroOf(spent);
    expect(within(hero).queryByText(/resets/)).toBeNull();
    expect(within(hero).queryByText(/pending/)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
    expect(screen.queryByTestId('budgets-hero-resets')).toBeNull();

    expect(heroLineIds(hero)).toEqual(['budgets-hero-spent', 'budgets-hero-payday']);
  });

  it('under budget → same two lines: "$4,501 / $5,785 spent" then "Next payday"', async () => {
    seedCoffee({ target: 5785, posted: 4500.6, pending: 0 });
    await renderLoadedBudgets();

    expect(screen.getByText('Left to spend')).toBeTruthy();

    const spent = screen.getByTestId('budgets-hero-spent');
    expect(screen.getByText('$4,501 / $5,785 spent')).toBe(spent);
    expect(screen.getByText(/^Next payday /)).toBe(screen.getByTestId('budgets-hero-payday'));

    const hero = heroOf(spent);
    expect(within(hero).queryByText(/resets/)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
    expect(heroLineIds(hero)).toEqual(['budgets-hero-spent', 'budgets-hero-payday']);
  });
});
