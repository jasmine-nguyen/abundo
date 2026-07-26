// WHIT-349 slice 3+4 — QA GAP screen tests for the Insights refund line.
// The implementer's insightsRefundLine.screen.test.tsx proves the refund line renders on
// expand and is tappable. These add the adversarial screen edges: the refund is NOT counted
// in the hero, is NOT a donut wedge / top-level "category", and the parent's headline shows
// the NETTED total (30), not the floored-leaf sum (60).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
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

// petrol 60, tolls net -30 (floored), car netted to 30 + a tolls refund line of -30.
function insightsData(over: Partial<{ breakdown: Record<string, unknown> }> = {}) {
  const breakdown: Record<string, unknown> = {
    petrol: { posted: 60, pending: 0 },
    tolls: { posted: 0, pending: 0 },
    __rollup__: { nodes: { car: { posted: 30, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
  };
  return { breakdown, earned: 0, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over } as { breakdown: Record<string, unknown>; earned: number; category: typeof category; isLoading: boolean; isError: boolean; refetch: () => void; refetchStale: () => void };
}

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

it('the hero shows the NETTED parent total (30), never the floored-leaf sum (60)', () => {
  render(<Insights />);
  // The hero total reads the netted cycle spend: car node 30, NOT petrol's floored 60.
  expect(screen.getByTestId('insights-hero-total').props.children).toBe('$30');
});

it('the refund is not counted as a category: "spent across 1 category"', () => {
  render(<Insights />);
  // One top-level category (Car). The refund line is NEVER a top-level row / donut wedge, so
  // the count stays 1 even though a Tolls refund line exists under Car.
  expect(screen.getByText('spent across 1 category')).toBeTruthy();
});

it('expanding does not change the hero total (refund is display-only)', () => {
  render(<Insights />);
  fireEvent.press(screen.getByText('Car'));
  // The refund line now renders, but the hero total is unchanged — it is excluded from the total.
  expect(screen.getByText(/refund/)).toBeTruthy();
  expect(screen.getByTestId('insights-hero-total').props.children).toBe('$30');
});
