// WHIT-724 — Budgets top card, over budget with a long pill: "resets in N days" sits on its own
// line (never squeezed beside the pill into one letter per line), and the legend caption is gone.
// Jest can't measure widths, so the squeeze guard checks the layout structure.
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
  // 30-day cycle: seedBudgetsTab's 14-day cycle would cap days_left below 22.
  seedBudgets(server, {
    budgets: { coffee: { target: 5785, posted: 5948.92, pending: 187.76 } },
    categories: [COFFEE],
    payCycle: { ...BUDGET_PAY_CYCLE, days_left: 22 },
  });
  resetRouter();
});

function hostViewAbove(node: ReactTestInstance): ReactTestInstance {
  let parent = node.parent;
  while (parent && String(parent.type) !== 'View') parent = parent.parent;
  if (!parent) throw new Error('no host View above node');
  return parent;
}

const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};

describe('WHIT-724 Budgets top card: reset text on its own line', () => {
  it('long over-budget pill → "resets in 22 days" is not squeezed beside the pill', async () => {
    await renderLoadedBudgets();
    expect(screen.getByText('Over budget')).toBeTruthy();

    const resets = screen.getByText('resets in 22 days');
    const pillText = screen.getByText(LONG_PILL);

    const resetsStyle = flat(resets);
    expect(resetsStyle.flex).toBeUndefined();
    expect(resetsStyle.minWidth).not.toBe(0);

    const pill = hostViewAbove(pillText);
    const resetsParent = hostViewAbove(resets);
    expect(hostViewAbove(pill)).toBe(resetsParent);
    expect(flat(resetsParent).flexDirection).not.toBe('row');

    expect(resets.props.testID).toBe('budgets-hero-resets');
    expect(screen.getByTestId('budgets-hero-pill')).toBe(pill);
  });

  it('the legend caption is gone', async () => {
    await renderLoadedBudgets();
    expect(screen.queryByText(/Solid = spent/)).toBeNull();
    expect(screen.queryByText(/faded = pending/)).toBeNull();
  });
});
