// WHIT-397 — adversarial gaps for the SegmentedControl extraction (pure refactor: any behaviour
// delta is the bug). Two things no existing suite locks:
//   [A9]  component contract: a `value` that matches NO option renders ZERO selected segments and
//         no active tint (guards the falsy-value / cleared-side path in `value === option.value`).
//   [A10] the REAL Insights toggles' active tint + text colour, pinned against the production theme
//         tokens (tint(C.bad,.16) / tint(C.good,.16) / C.accentSoft) so a future colour swap in
//         insights.tsx — the exact drift this refactor could hide — fails here. The component test
//         (segmentedControl.screen.test.tsx) only uses fake colours; the toggle screen suites assert
//         testID/label/selection but never the colours.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SegmentedControl } from '../components/SegmentedControl';
import { C, tint } from '../theme';
import type { AppContext, LoanFacts } from '../context';

// ---- [A9] component contract: value matches no option -------------------------------------------
describe('SegmentedControl — value matches no option', () => {
  const OPTS = [
    { value: 'spending' as const, label: 'Spending', testID: 'seg-spending', activeTint: 'rgba(1,2,3,.16)', activeTextColor: '#f7768e' },
    { value: 'earning' as const, label: 'Earning', testID: 'seg-earning', activeTint: 'rgba(4,5,6,.16)', activeTextColor: '#2ac3de' },
  ];
  const styleOf = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);
  const textStyleOf = (label: string) => StyleSheet.flatten(screen.getByText(label).props.style);

  it('[A9] a value matching no option leaves every segment unselected and untinted', () => {
    // A value that matches no option (a cleared/unknown side) must render as a blank — no crash.
    render(<SegmentedControl value="none" onChange={jest.fn()} options={OPTS} />);
    expect(screen.getByTestId('seg-spending').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('seg-earning').props.accessibilityState.selected).toBe(false);
    expect(styleOf('seg-spending').backgroundColor).toBeUndefined();
    expect(styleOf('seg-earning').backgroundColor).toBeUndefined();
    // no segment took the bold active weight
    expect(textStyleOf('Spending').fontWeight).toBe('600');
    expect(textStyleOf('Earning').fontWeight).toBe('600');
  });
});

// ---- [A10] real Insights toggle colours, pinned to production theme tokens -----------------------
type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

let mockInsights: { breakdown: Record<string, { posted: number; pending: number }>; earned: number; incomeSources: { id: string; posted: number; pending: number; amount: number }[]; category: (id: string) => never; isLoading: boolean; isError: boolean; refetch: () => void; refetchStale: () => void };
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

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 0 },
  { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#2ac3de', bucket: 'Income', recent: 0 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;
const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

const flat = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);
const textFlat = (label: string) => StyleSheet.flatten(screen.getByText(label).props.style);

beforeEach(() => {
  mockState = {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null },
  };
  // spend + income both present → both toggles visible
  mockInsights = {
    breakdown: { coffee: { posted: 20, pending: 0 } },
    earned: 3000,
    incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
    category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(),
  };
});

describe('Insights toggles — active colours pinned to production tokens (WHIT-397)', () => {
  it('[A10] cycle toggle: active "This cycle" carries the blue tint + accentSoft bold text', () => {
    render(<Insights />);
    // active on mount (cycle = 0)
    // Pinned to the literal, not to tint(C.accentAlt, .16) — asserting against the token would
    // pass even if the token were repainted. accentAltToken.logic.test.ts pins the token itself.
    expect(flat('insights-cycle-current').backgroundColor).toBe('rgba(124,140,255,0.16)');
    expect(textFlat('This cycle').color).toBe(C.accentSoft);
    expect(textFlat('This cycle').fontWeight).toBe('700');
    // inactive segment: no tint
    expect(flat('insights-cycle-prev').backgroundColor).toBeUndefined();
    expect(textFlat('Last cycle').fontWeight).toBe('600');
  });

  // [A11] WHIT-398 — the DRY property the token exists for: the two cycle options are one colour,
  // not two that happen to match. Both options were written out separately before the token, so an
  // edit that changed only one of them would have passed every other assertion in this file.
  it('[A11] cycle toggle: both options light up the SAME blue', () => {
    render(<Insights />);
    const currentActiveTint = flat('insights-cycle-current').backgroundColor;
    // anchored, so "both are ONE colour" can't be satisfied by "neither has a colour"
    expect(currentActiveTint).toBe('rgba(124,140,255,0.16)');
    fireEvent.press(screen.getByTestId('insights-cycle-prev'));
    expect(flat('insights-cycle-prev').backgroundColor).toBe(currentActiveTint);
    // and the handover is clean — the previously active segment drops its tint
    expect(flat('insights-cycle-current').backgroundColor).toBeUndefined();
  });

  it('[A10] side toggle: Spending active = coral (tint(C.bad,.16) + C.bad text)', () => {
    render(<Insights />);
    expect(flat('insights-side-spending').backgroundColor).toBe(tint(C.bad, 0.16));
    expect(textFlat('Spending').color).toBe(C.bad);
    expect(textFlat('Spending').fontWeight).toBe('700');
    // earning inactive
    expect(flat('insights-side-earning').backgroundColor).toBeUndefined();
    expect(textFlat('Earning').fontWeight).toBe('600');
  });

  it('[A10] side toggle: Earning active = teal (tint(C.good,.16) + C.good text) after tap', () => {
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(flat('insights-side-earning').backgroundColor).toBe(tint(C.good, 0.16));
    expect(textFlat('Earning').color).toBe(C.good);
    expect(textFlat('Earning').fontWeight).toBe('700');
    // spending now inactive
    expect(flat('insights-side-spending').backgroundColor).toBeUndefined();
    expect(textFlat('Spending').fontWeight).toBe('600');
  });
});
