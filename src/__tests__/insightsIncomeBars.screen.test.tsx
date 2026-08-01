// WHIT-373 — adversarial screen gaps for the Insights "Earning" list. The existing
// insightsSideToggle.screen.test.tsx locks the text/labels/drills; this file locks the parts that
// suite never touches: the GREEN SHARE BARS (the `incomeShareTotal` denominator + `barPct` clamp
// inline in app/(tabs)/insights.tsx), the muted reconcile PLUG (must get NO bar and NO drill), the
// all-reversed cycle (denominator 0 → no div-by-zero, no bar), and a stale 'earning' choice carried
// into a later spend-only cycle. Same mock harness as insightsSideToggle: real categoryBreakdown +
// incomeBreakdown selectors run over mocked query data; router + AI store mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';
import { CATEGORY_COLORS } from '../theme/chartColors';

type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

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

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]), useRouter: () => ({ push: mockPush }) };
});

import Insights from '../../app/(tabs)/insights';

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7FD49B', bucket: 'Living', recent: 0 },
  { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#2ac3de', bucket: 'Income', recent: 0 },
  { id: 'dividends', name: 'Dividends', icon: 'trend', color: '#9ece6a', bucket: 'Income', recent: 0 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;
const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }>; earned: number; incomeSources: { id: string; posted: number; pending: number; amount: number }[]; isLoading: boolean; isError: boolean }>) {
  return { breakdown: {}, earned: 0, incomeSources: [], category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}
function state(): InsightsState {
  return {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null },
  };
}

// The income share bars are inline Views filled with the SOURCE's chart-palette colour (WHIT chart
// palette — each source its own colour, matching the pie, not a flat green). They're the only nodes
// whose raw backgroundColor is a CATEGORY_COLORS hex: chips are rgba(tint) and the EarnedVsSpent card
// bars are C.good/C.bad (not in the ramp), so neither matches. Collect each matching fill's width.
const RAMP = new Set<string>(CATEGORY_COLORS);
function incomeBarWidths(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach((n) => incomeBarWidths(n, acc)); return acc; }
  const n = node as { props?: { style?: unknown; testID?: string }; children?: unknown[] };
  const style = n.props?.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style || {});
  if (RAMP.has((flat as { backgroundColor?: string }).backgroundColor as string)) {
    acc.push(String((flat as { width?: unknown }).width));
  }
  if (Array.isArray(n.children)) n.children.forEach((c) => incomeBarWidths(c, acc));
  return acc;
}

beforeEach(() => {
  mockPush.mockClear();
  mockState = state();
  mockInsights = insightsData({});
});

describe('Insights "Earning" share bars (WHIT-373)', () => {
  // [B1] Two positive sources → two green bars sized by share of shown income (3000 vs 500 of 3500).
  // The bigger source's bar must be wider. FAIL-ON-REVERT: if barPct divided by `earned` (or dropped
  // the incomeShareTotal denominator) the widths change; if the guard let the plug/reversed rows bar,
  // the count changes.
  it('[B1] draws a proportional green bar per positive source, biggest widest', () => {
    mockInsights = insightsData({
      breakdown: { coffee: { posted: 20, pending: 0 } },
      earned: 3500,
      incomeSources: [
        { id: 'salary', posted: 3000, pending: 0, amount: 3000 },
        { id: 'dividends', posted: 500, pending: 0, amount: 500 },
      ],
    });
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    const widths = incomeBarWidths(screen.toJSON());
    expect(widths).toHaveLength(2);
    // salary 3000/3500 ≈ 85.7% ; dividends 500/3500 ≈ 14.3%
    expect(parseFloat(widths[0])).toBeCloseTo((3000 / 3500) * 100, 5);
    expect(parseFloat(widths[1])).toBeCloseTo((500 / 3500) * 100, 5);
    expect(parseFloat(widths[0])).toBeGreaterThan(parseFloat(widths[1]));
  });

  // [B2] The muted reconcile plug is not a real source: it must render its label, get NO green bar,
  // and NOT be tappable. earned 3120 vs one 3000 source ⇒ a 120 plug. FAIL-ON-REVERT: wrapping the
  // muted row in a Pressable (drill) makes the press fire mockPush; letting the plug bar makes the
  // width count 2.
  it('[B2] the muted reconcile plug gets no bar and does not drill', () => {
    mockInsights = insightsData({
      breakdown: { coffee: { posted: 40, pending: 0 } },
      earned: 3120,
      incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
    });
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('Pending/refund adjustment')).toBeTruthy();
    // only the real source (salary) gets a green bar — the plug does not
    expect(incomeBarWidths(screen.toJSON())).toHaveLength(1);
    // tapping the plug row navigates nowhere (it has no Pressable wrapper)
    fireEvent.press(screen.getByText('Pending/refund adjustment'));
    expect(mockPush).not.toHaveBeenCalled();
    // the real source still drills
    fireEvent.press(screen.getByText('Salary'));
    expect(mockPush).toHaveBeenCalledWith('/category/salary?cycle=0');
  });

  // [B3] Every source clawed back this cycle → the positive denominator is 0. Rows still render (as
  // −$X), but NO bar may be drawn — no div-by-zero, no NaN width. earned = shownAmount so no plug.
  // NOTE: double-guarded (the `incomeShareTotal > 0` denominator AND the per-row `r.amount > 0` gate),
  // so no single revert reddens this — it's a defensive regression guard, not a fail-on-revert test.
  it('[B3] an all-reversed cycle renders rows but zero bars (denominator 0 is safe)', () => {
    mockInsights = insightsData({
      breakdown: {},
      earned: -300,
      incomeSources: [
        { id: 'salary', posted: -200, pending: 0, amount: -200 },
        { id: 'dividends', posted: -100, pending: 0, amount: -100 },
      ],
    });
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('-$200')).toBeTruthy();
    expect(screen.getByText('-$100')).toBeTruthy();
    expect(incomeBarWidths(screen.toJSON())).toHaveLength(0); // no green bars at all
  });

  // [B4] Stale-side carry: a user on Earning who moves to a spend-only cycle keeps the toggle (spend
  // has content) and lands on an honest "No income" empty — never a blank, never a category row on
  // the Earning side. Documents the clamp's real behaviour (side = sideChoice while the toggle shows).
  it('[B4] Earning choice carried into a later spend-only cycle shows the income empty, toggle intact', () => {
    mockInsights = insightsData({
      breakdown: { coffee: { posted: 20, pending: 0 } },
      earned: 3500,
      incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
    });
    const { rerender } = render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('Salary')).toBeTruthy();
    // same screen, new cycle's data arrives: spend only, no income sources
    mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 0 } }, earned: 0, incomeSources: [] });
    rerender(<Insights />);
    expect(screen.getByTestId('insights-side-earning')).toBeTruthy();        // toggle stays (spend present)
    expect(screen.getByText('No income yet this pay cycle.')).toBeTruthy();   // honest empty, not a spend row
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();                 // still on Earning, spend hidden
    expect(incomeBarWidths(screen.toJSON())).toHaveLength(0);
  });
});
