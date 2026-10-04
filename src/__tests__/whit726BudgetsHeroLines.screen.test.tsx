// WHIT-726 → WHIT-731 — Budgets top card: no pill and no "resets in"; one row of three labelled
// values, Spent · Budget · Next payday (whole dollars, pending included in Spent). No pending on the card.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE } from './support/categories';
import { BUDGET_PAY_CYCLE, seedBudgets, renderLoadedBudgets, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

const STAT_IDS = ['budgets-hero-spent', 'budgets-hero-budget', 'budgets-hero-payday'];

function seedCoffee(coffee: { target: number; posted: number; pending?: number }) {
  seedBudgets(server, {
    budgets: { coffee },
    categories: [COFFEE],
    payCycle: { ...BUDGET_PAY_CYCLE, days_left: 22 },
  });
}

// The hero card: the closest host View above the eyebrow that holds the stats row.
function hero(): ReactTestInstance {
  let node: ReactTestInstance | null = screen.getByText('THIS PAY CYCLE');
  while (node && !(String(node.type) === 'View' && within(node).queryByTestId('budgets-hero-payday'))) node = node.parent;
  if (!node) throw new Error('no hero card');
  return node;
}

function statIdsInHero() {
  return hero()
    .findAll((node) => typeof node.type === 'string' && STAT_IDS.includes(node.props.testID))
    .map((node) => node.props.testID);
}

beforeEach(() => resetRouter());

describe('WHIT-731 Budgets top card: Spent · Budget · Next payday', () => {
  it('over budget → Spent $6,137 · Budget $5,785 · Next payday, with no resets or pending on the card', async () => {
    seedCoffee({ target: 5785, posted: 5948.92, pending: 187.76 });
    await renderLoadedBudgets();

    // 5948.92 posted + 187.76 pending − 5785 budget = 351.68 over (the money number keeps its cents).
    expect(screen.getByText('−$351.68')).toBeTruthy();
    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$6,137', budget: '$5,785' });
    expect(heroTotals().payday).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);

    expect(within(hero()).queryByText(/resets/)).toBeNull();
    expect(within(hero()).queryByText(/pending/)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
    expect(screen.queryByTestId('budgets-hero-resets')).toBeNull();
    expect(statIdsInHero()).toEqual(STAT_IDS);
  });

  it('under budget → same three values: Spent $4,501 · Budget $5,785 · Next payday', async () => {
    seedCoffee({ target: 5785, posted: 4500.6, pending: 0 });
    await renderLoadedBudgets();

    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$4,501', budget: '$5,785' });
    expect(heroTotals().payday).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);

    expect(within(hero()).queryByText(/resets/)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
    expect(statIdsInHero()).toEqual(STAT_IDS);
  });
});
