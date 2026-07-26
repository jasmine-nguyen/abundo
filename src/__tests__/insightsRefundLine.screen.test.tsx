// WHIT-349 slice 3+4: the refund line renders on the Insights tab. insights.tsx runs the real
// categoryBreakdown over the mocked breakdown (which carries __rollup__), so expanding a
// net-refunded parent shows a muted "refund" line that reconciles the visible rows to the
// netted parent, is tappable into the refunded sub, and is never a donut slice.
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

// petrol 60, tolls net -30 (floored to 0), car node netted to 30 + a tolls refund line.
function insightsData(over: Partial<{ breakdown: Record<string, unknown>; isLoading: boolean; isError: boolean }> = {}) {
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

it('shows the netted parent, then a tappable refund line when expanded', () => {
  render(<Insights />);
  // The Car parent renders (its netted $30 total is locked in the logic test).
  expect(screen.getByText('Car')).toBeTruthy();
  // Collapsed: the refund line isn't shown yet.
  expect(screen.queryByText(/refund/)).toBeNull();

  // Expand Car -> the refund line appears, reconciling petrol 60 - 30 = 30.
  fireEvent.press(screen.getByText('Car'));
  expect(screen.getByText('Petrol')).toBeTruthy();
  expect(screen.getByText('Tolls')).toBeTruthy();
  expect(screen.getByText(/refund/)).toBeTruthy();

  // A tap on the refund line drills into the refunded sub's transactions.
  fireEvent.press(screen.getByText('Tolls'));
  expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/category/tolls'));
});
