// WHIT chart palette — [A7] the Insights "Earning" tab must recolour its income-source rows from the
// ramp too. The screen passes the wrapped accessor to incomeBreakdown (insights.tsx line ~41); if that
// line were reverted to the raw `category`, the source's icon/chip would show the OLD app-wide hue.
// The mock category carries the OLD colour (#2ac3de); we tap to Earning and assert the row chip's
// tinted background is the RAMP colour's tint, and the old colour's tint is absent — fail-on-revert.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { tint } from '../theme';
import { chartCategoryColor } from '../chartColors';
import type { AppContext, LoanFacts } from '../context';

type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

jest.mock('../components/SpendingDonut', () => ({ SpendingDonut: () => null }));

let mockInsights: ReturnType<typeof insightsData>;
jest.mock('../queries', () => ({
  useInsightsScreenData: () => mockInsights,
  useGoalScreenData: () => ({ loanFacts: mockState.loanFacts, homeLoan: mockState.homeLoan, repayment: { amount: null, date: null, principal: null, interest: null }, isLoading: false, isError: false, homeLoanError: false, refetch: jest.fn(), refetchStale: jest.fn() }),
}));

let mockState: InsightsState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Insights from '../../app/(tabs)/insights';

// Mock categories carry the OLD app-wide colours — the wrapper must override them with the ramp.
const OLD_SALARY = '#2ac3de';
const CATS = [
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#9ece6a', bucket: 'Living', recent: 0 },
  { id: 'salary', name: 'Salary', icon: 'briefcase', color: OLD_SALARY, bucket: 'Income', recent: 0, colorSlot: 2 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;
const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }>; earned: number; incomeSources: { id: string; posted: number; pending: number; amount: number }[] }>) {
  return { breakdown: {}, earned: 0, incomeSources: [], category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}

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
  mockState = {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null },
  };
  // Spend (so the Spending/Earning toggle shows) + an income source to recolour.
  mockInsights = insightsData({
    breakdown: { groceries: { posted: 80, pending: 0 } },
    earned: 3000,
    incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
  });
});

describe('Insights Earning tab recolours income-source rows from the chart palette', () => {
  it('[A7] the income source chip uses the ramp colour tint, not the old category hue', () => {
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    const tree = screen.toJSON();
    // chip background = tint(row.color, 0.15); row.color must be the ramp slot for 'salary'.
    expect(hasFillColor(tree, tint(chartCategoryColor('salary', { slot: 2 }), 0.15))).toBe(true);
    // the hashed fallback colour must be ABSENT — the stored slot won
    expect(hasFillColor(tree, tint(chartCategoryColor('salary'), 0.15))).toBe(false);
    expect(hasFillColor(tree, tint(OLD_SALARY, 0.15))).toBe(false);
  });

  it('[A7b] the income source bar is the source ramp colour, matching the pie — not flat green', () => {
    render(<Insights />);
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
