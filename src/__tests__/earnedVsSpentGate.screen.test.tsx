// WHIT-324 (qa adversarial) — the Insights screen gate `(earned > 0 || rows.length > 0)` at its
// boundary. The implementer's InsightsScreen suite pins earned-only (income, no rows) and the
// both-zero null case, but NOT the mirror branch: earned EXACTLY 0 WITH spend rows — the
// "spent before payday landed" case where the OR passes on rows.length, and the card must show a
// deficit of the whole spend. Same mock harness as InsightsScreen.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
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

jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Insights from '../../app/(tabs)/insights';

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 0 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;
const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }>; earned: number; isLoading: boolean; isError: boolean }>) {
  return { breakdown: {}, earned: 0, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}
function state(over: Partial<InsightsState>): InsightsState {
  return {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null }, ...over,
  };
}

beforeEach(() => { mockInsights = insightsData({}); mockState = state({}); });

describe('earned-vs-spent gate — earned exactly 0 with spend rows [G5]', () => {
  // The OR's rows.length branch: earned is 0 (payday hasn't landed) but there IS spend → the card
  // shows, reading a deficit of the whole spend. Guards that a future `earned > 0` tightening of
  // the gate wouldn't silently drop the card on a spend-only cycle.
  it('shows the card as a full deficit when earned is 0 but there is spend', () => {
    mockInsights = insightsData({ breakdown: { coffee: { posted: 100, pending: 0 } }, earned: 0 });
    render(<Insights />);
    expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
    expect(screen.getByTestId('spent-bar').props.style.width).toBe('100%');
    expect(screen.getByTestId('earned-bar').props.style.width).toBe('0%');
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('−$100 deficit');
  });

  // The exact seam: 0 earned AND 0 rows → the OR is false → card absent (already asserted in the
  // implementer's suite, re-pinned here beside its mirror so the boundary pair reads together).
  it('hides the card when earned is 0 and there are no spend rows', () => {
    mockInsights = insightsData({ breakdown: {}, earned: 0 });
    render(<Insights />);
    expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
  });
});
