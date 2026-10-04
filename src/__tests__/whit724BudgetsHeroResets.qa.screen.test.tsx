// WHIT-724 QA — the long pill and the reset line stay readable at large text sizes: the pill
// wraps inside the card (never pushes sideways or truncates), and no row up to the top card
// squeezes the reset line. Jest can't measure widths, so these check the layout structure.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
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
const LONG_PILL = '$6,136.68 spent of $5,785 · $187.76 pending';

beforeEach(() => {
  seedBudgets(server, {
    budgets: { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } },
    categories: [COFFEE],
    payCycle: { ...BUDGET_PAY_CYCLE, days_left: 22 },
  });
  resetRouter();
});

const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};

describe('WHIT-724 QA: long pill + reset line stay readable', () => {
  // [A1] (P0) the pill wraps inside the card; neither text is cut to one line
  it('[A1] long pill is capped to the card width and neither text is truncated', async () => {
    await renderLoadedBudgets();

    const pill = screen.getByTestId('budgets-hero-pill');
    expect(flat(pill).maxWidth).toBe('100%');
    expect(flat(pill).alignSelf).toBe('flex-start');

    expect(screen.getByText(LONG_PILL).props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId('budgets-hero-resets').props.numberOfLines).toBeUndefined();
  });

  // [A2] (P0) no row anywhere between the reset line and the top card squeezes it
  it('[A2] no ancestor of the reset line inside the top card lays out in a row', async () => {
    await renderLoadedBudgets();

    let card = screen.getByText('THIS PAY CYCLE').parent!;
    while (String(card.type) !== 'View') card = card.parent!;
    let node = screen.getByTestId('budgets-hero-resets').parent;
    while (node && node !== card) {
      if (String(node.type) === 'View') expect(flat(node).flexDirection).not.toBe('row');
      node = node.parent;
    }
    expect(node).toBe(card);
  });
});
