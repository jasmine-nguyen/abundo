// WHIT-726 → WHIT-731 — Budgets top card: no pill, no "resets in" and no pending on the card. The
// over-budget values and the Spent · Budget · Next payday order are covered in
// whit731BudgetsHeroStats.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { resetRouter } from './support/routerMock';
import { installFakeServer } from './support/fakeServer';
import { COFFEE } from './support/categories';
import { BUDGET_PAY_CYCLE, seedBudgets, renderLoadedBudgets, heroTotals } from './support/budgetsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();

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

beforeEach(() => resetRouter());

describe('WHIT-731 Budgets top card: no pill, resets or pending', () => {
  it('over budget with pending → no resets, pending or pill on the card', async () => {
    seedCoffee({ target: 5785, posted: 5948.92, pending: 187.76 });
    await renderLoadedBudgets();

    expect(screen.getByText('Over budget')).toBeTruthy();
    expect(within(hero()).queryByText(/resets/)).toBeNull();
    expect(within(hero()).queryByText(/pending/)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
    expect(screen.queryByTestId('budgets-hero-resets')).toBeNull();
  });

  it('under budget → same three values: Spent $4,500.60 · Budget $5,785 · Next payday', async () => {
    seedCoffee({ target: 5785, posted: 4500.6, pending: 0 });
    await renderLoadedBudgets();

    expect(screen.getByText('Left to spend')).toBeTruthy();
    expect(heroTotals()).toMatchObject({ spent: '$4,500.60', budget: '$5,785' });
    expect(heroTotals().payday).toMatch(/^\d{1,2} [A-Z][a-z]{2}$/);

    expect(within(hero()).queryByText(/resets/)).toBeNull();
    expect(screen.queryByTestId('budgets-hero-pill')).toBeNull();
  });
});
