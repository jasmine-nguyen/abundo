// WHIT chart palette — [A7] the Insights "Earning" tab must recolour its income-source rows from the
// ramp too. The screen passes the wrapped accessor to incomeBreakdown (insights.tsx line ~41); if that
// line were reverted to the raw `category`, the source's icon/chip would show the app-wide hue.
// We tap to Earning and assert the row chip's tinted background is the RAMP colour's tint, and the
// id-derived colour's tint is absent — fail-on-revert. WHIT-687: drawn over the fake server with the
// shared Insights kit, so the real __income__ read and category mapping run.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen, fireEvent } from '@testing-library/react-native';
import { tint } from '../theme';
import { chartCategoryColor } from '../chartColors';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, resetAi } from './support/insightsScreen';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());
jest.mock('../components/SpendingDonut', () => ({ SpendingDonut: () => null }));
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

const server = installFakeServer();
useTestQueryClient();

const CATS = [
  { id: 'groceries', name: 'Groceries', icon: 'cart', bucket: 'Living', recent: 0 },
  { id: 'salary', name: 'Salary', icon: 'briefcase', bucket: 'Income', recent: 0, colorSlot: 2 },
];

// Walk the tree for a View filled with `bg`.
function hasFillColor(node: unknown, bg: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => hasFillColor(n, bg));
  const n = node as { props?: { style?: unknown }; children?: unknown[] };
  const flat = StyleSheet.flatten(n.props?.style as never) || {};
  if ((flat as { backgroundColor?: string }).backgroundColor === bg) return true;
  return Array.isArray(n.children) && n.children.some((c) => hasFillColor(c, bg));
}

beforeEach(() => {
  resetAuth();
  resetAi();
  // Spend (so the Spending/Earning toggle shows) + an income source to recolour.
  seedInsights(server, {
    breakdown: breakdownWire({
      spend: { groceries: { posted: 80, pending: 0 } },
      earned: 3000,
      income: { salary: { posted: 3000, pending: 0 } },
    }),
    categories: CATS,
  });
});

describe('Insights Earning tab recolours income-source rows from the chart palette', () => {
  it('[A7] the income source chip uses the ramp colour tint, not the id-derived hue', async () => {
    await renderInsights();
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    const tree = screen.toJSON();
    // chip background = tint(row.color, 0.15); row.color must be the ramp slot for 'salary'.
    expect(hasFillColor(tree, tint(chartCategoryColor('salary', { slot: 2 }), 0.15))).toBe(true);
    // the hashed fallback colour must be ABSENT — the stored slot won
    expect(hasFillColor(tree, tint(chartCategoryColor('salary'), 0.15))).toBe(false);
  });

  it('[A7b] the income source bar is the source ramp colour, matching the pie — not flat green', async () => {
    await renderInsights();
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    const tree = screen.toJSON();
    // The share bar fill is the raw ramp colour for the source (same treatment as the pie + spending
    // rows). The salary chip is tint(colour, .15) and the icon colour is a prop, so the ONLY
    // backgroundColor equal to the raw ramp hex is the bar. FAIL-ON-REVERT: revert the bar to the old
    // flat C.good and this raw-hex fill disappears → the assertion reddens. (C.good itself can't be
    // asserted absent — the EarnedVsSpent summary card's teal "Earned" bar is legitimately C.good.)
    expect(hasFillColor(tree, chartCategoryColor('salary', { slot: 2 }))).toBe(true);
    expect(hasFillColor(tree, chartCategoryColor('salary'))).toBe(false);
  });
});
