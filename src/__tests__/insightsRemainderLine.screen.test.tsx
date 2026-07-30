// WHIT-357: the synthetic "Other" remainder line renders on the Insights tab. insights.tsx runs the
// real categoryBreakdown over the mocked breakdown (which carries __rollup__), so expanding a parent
// whose visible children don't sum to its node shows a MUTED "Other" line that (a) is neutral-coloured
// (not the refund green), (b) has NO bar/track, and (c) is NOT tappable — unlike the refund line under
// the same parent, which IS tappable. Modelled on insightsRefundLine.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { C } from '../theme';
import type { AppContext, LoanFacts } from '../context';

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
  { id: 'car', name: 'Car', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: null, recent: 0 },
  { id: 'petrol', name: 'Petrol', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
  { id: 'tolls', name: 'Tolls', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;

// petrol 100, tolls net -30 (floored to 0 -> refund line), car node 130. The visible children sum to
// 100 + (-30) = 70, under-summing the node (130) -> WHIT-357 plugs a +60 "Other" line under car.
// $60 appears nowhere else on screen (100 / 130 / 30 are the other amounts), so it uniquely marks the plug.
function insightsData(over: Partial<{ breakdown: Record<string, unknown>; isLoading: boolean; isError: boolean }> = {}) {
  const breakdown: Record<string, unknown> = {
    petrol: { posted: 100, pending: 0 },
    tolls: { posted: 0, pending: 0 },
    __rollup__: { nodes: { car: { posted: 130, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
  };
  return { breakdown, earned: 0, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over } as { breakdown: Record<string, unknown>; earned: number; category: typeof category; isLoading: boolean; isError: boolean; refetch: () => void; refetchStale: () => void };
}

// Climb to the enclosing row card (styles.row is the only node with borderRadius 20).
function rowCard(node: ReactTestInstance): ReactTestInstance {
  let n: ReactTestInstance | null = node;
  while (n) {
    const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { borderRadius?: number } | undefined;
    if (st && st.borderRadius === 20) return n;
    n = n.parent;
  }
  throw new Error('no enclosing row card');
}
// A category-bar track (styles.track: height 8) — present on a real spend row, absent on a plug/refund.
const tracksIn = (card: ReactTestInstance) => card.findAll((n) => {
  const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { height?: number } | undefined;
  return !!st && st.height === 8;
});
// The bold amount Text (styles.rowAmount: fontWeight '700') inside a card.
const amountColor = (card: ReactTestInstance) => {
  const amt = card.findAll((n) => {
    const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { fontWeight?: string } | undefined;
    return !!st && st.fontWeight === '700';
  })[0];
  return (StyleSheet.flatten((amt.props as { style?: unknown }).style) as { color?: string }).color;
};

// The row NAME Text (styles.rowName: fontWeight '600') inside a card — its colour moved from a
// hardcoded C.textDim to breakdownLineStyle's nameColor in WHIT-375, so lock it here.
const nameColor = (card: ReactTestInstance) => {
  const nm = card.findAll((n) => {
    const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { fontWeight?: string } | undefined;
    return !!st && st.fontWeight === '600';
  })[0];
  return (StyleSheet.flatten((nm.props as { style?: unknown }).style) as { color?: string }).color;
};

beforeEach(() => {
  mockPush.mockClear();
  mockInsights = insightsData();
  mockState = {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null } as LoanFacts,
    homeLoan: { balance: null, asOf: null },
  };
});

it('hides the "Other" plug until the parent is expanded, then shows it muted, un-barred, and un-tappable', () => {
  render(<Insights />);
  // Collapsed: the plug is not shown.
  expect(screen.queryByText('Pending/refund adjustment')).toBeNull();

  // Expand Car -> children + the refund line + the adjustment plug appear.
  fireEvent.press(screen.getByText('Car'));
  expect(screen.getByText('Petrol')).toBeTruthy();
  const other = screen.getByText('Pending/refund adjustment');
  expect(other).toBeTruthy();

  const card = rowCard(other);
  // (a) neutral-coloured amount — textDim, NOT the refund green (C.good).
  expect(amountColor(card)).toBe(C.textDim);
  expect(amountColor(card)).not.toBe(C.good);
  // (b) NO bar/track under the plug row.
  expect(tracksIn(card)).toHaveLength(0);
  // (c) NOT tappable — no button in the row, and pressing it drills nowhere.
  expect(within(card).queryByRole('button')).toBeNull();
  fireEvent.press(other);
  expect(mockPush).not.toHaveBeenCalled();
});

it('the refund line under the SAME parent stays green + tappable — proving the plug checks are meaningful', () => {
  render(<Insights />);
  fireEvent.press(screen.getByText('Car'));

  // Positive control 1: the refund line ('Tolls') is green and IS a drill target.
  const refundCard = rowCard(screen.getByText('Tolls'));
  expect(amountColor(refundCard)).toBe(C.good);
  expect(within(refundCard).queryByRole('button')).toBeTruthy();
  fireEvent.press(screen.getByText('Tolls'));
  expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/category/tolls'));

  // Positive control 2: a real spend row (Petrol) DOES carry a bar/track — so the plug's
  // "no track" assertion above is a real difference, not a query that never finds tracks.
  expect(tracksIn(rowCard(screen.getByText('Petrol')))).not.toHaveLength(0);
});

// WHIT-375 — [A1] gap symmetric to the breakdown refund test. insightsRemainderLine only locked
// the refund COLOUR (green) + tappability, never that its AMOUNT is UNSIGNED. The refund's spent is
// -30; the shared breakdownLineStyle must drop the sign so the line reads "$30", never "-$30" (the
// historical drift the card guards). Fail-on-revert: sign the helper's amount and this flips to "-$30".
it('renders the refund line amount UNSIGNED ("$30", never "-$30")', () => {
  render(<Insights />);
  fireEvent.press(screen.getByText('Car'));

  const refundCard = rowCard(screen.getByText('Tolls'));
  expect(within(refundCard).getByText('$30')).toBeTruthy();   // unsigned credit
  expect(within(refundCard).queryByText('-$30')).toBeNull();  // never the signed drift
});

// WHIT-375 — [A2] the refund/remainder NAME colour moved from a hardcoded C.textDim to the helper's
// nameColor. Prove it's unchanged on BOTH kinds of line: dimmed (C.textDim), NOT the bright category
// ink (C.textBright). Fail-on-revert: if the helper returned textBright for a refund/remainder name,
// these flip.
it('keeps the refund AND remainder NAME dimmed (C.textDim, not the bright ink)', () => {
  render(<Insights />);
  fireEvent.press(screen.getByText('Car'));

  const refundName = nameColor(rowCard(screen.getByText('Tolls')));
  expect(refundName).toBe(C.textDim);
  expect(refundName).not.toBe(C.textBright);

  const plugName = nameColor(rowCard(screen.getByText('Pending/refund adjustment')));
  expect(plugName).toBe(C.textDim);
  expect(plugName).not.toBe(C.textBright);

  // Control: a real spend row (Petrol) keeps the BRIGHT name — so "dimmed" is a real difference,
  // not a colour every row happens to share.
  expect(nameColor(rowCard(screen.getByText('Petrol')))).toBe(C.textBright);
});

it('a NEGATIVE "Other" plug renders its minus sign (WHIT-357 R1) so the rows visibly still add up', () => {
  // Trigger-2 shape: car own spend 100, but its node is 60 (a dropped net-negative sub ate 40).
  // The plug is -40. `fmt` strips the sign, so without the R1 fix this renders "$40" and the rows
  // read as 100 + 40 = 140 under a $60 parent. Assert the minus is shown.
  mockInsights = insightsData({
    breakdown: {
      car: { posted: 100, pending: 0 },       // car's OWN directly-tagged spend -> "Directly in Car" 100
      petrol: { posted: 0, pending: 0 },       // a sub that floored away (keeps car a parent)
      __rollup__: { nodes: { car: { posted: 60, pending: 0 } } },   // node 60 < own 100 -> -40 plug
    },
  });
  render(<Insights />);
  fireEvent.press(screen.getByText('Car'));

  const other = screen.getByText('Pending/refund adjustment');
  const card = rowCard(other);
  // The amount shows the sign: "-$40", not a bare "$40".
  expect(within(card).getByText('-$40')).toBeTruthy();
  expect(within(card).queryByText('$40')).toBeNull();   // no unsigned amount that would mislead
});
