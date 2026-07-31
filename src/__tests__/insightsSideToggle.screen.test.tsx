// Screen test: the Insights "Spending / Earning" toggle (WHIT-373). Replaces the retired /breakdown
// drill — one list, a switch. Spending (default) shows the category breakdown; Earning shows the same
// cycle's income sources. The real categoryBreakdown + incomeBreakdown selectors run over the mocked
// breakdown/incomeSources; the query composite and the AI store are mocked (as in InsightsScreen).
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
    aiInsights: null,
    aiInsightsLoading: false,
    aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS,
    homeLoan: { balance: null, asOf: null },
  };
}

// Spend + income both present, so the toggle has content on both sides.
const BOTH = {
  breakdown: { coffee: { posted: 20, pending: 0 }, groceries: { posted: 80, pending: 0 } },
  earned: 3500,
  incomeSources: [
    { id: 'salary', posted: 3000, pending: 0, amount: 3000 },
    { id: 'dividends', posted: 500, pending: 0, amount: 500 },
  ],
};

beforeEach(() => {
  mockPush.mockClear();
  mockState = state();
  mockInsights = insightsData({});
});

describe('Spending / Earning toggle (WHIT-373)', () => {
  it('defaults to Spending: category rows + spend caption show, income does not', () => {
    mockInsights = insightsData(BOTH);
    render(<Insights />);
    expect(screen.getByTestId('insights-side-spending')).toBeTruthy();
    expect(screen.getByTestId('insights-bars-caption')).toBeTruthy();           // spend caption
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByText('Salary')).toBeNull();                            // income hidden
    expect(screen.queryByTestId('insights-income-caption')).toBeNull();
  });

  it('switching to Earning shows income sources and hides the category rows', () => {
    mockInsights = insightsData(BOTH);
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('Salary')).toBeTruthy();
    expect(screen.getByText('$3,000')).toBeTruthy();
    expect(screen.getByText('Dividends')).toBeTruthy();
    expect(screen.getByTestId('insights-income-caption')).toBeTruthy();         // income caption
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();                    // spending hidden
    expect(screen.queryByTestId('insights-bars-caption')).toBeNull();
  });

  it('switching back to Spending restores the category rows', () => {
    mockInsights = insightsData(BOTH);
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    fireEvent.press(screen.getByTestId('insights-side-spending'));
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByText('Salary')).toBeNull();
  });

  it('taps an income source into its transactions for the selected cycle', () => {
    mockInsights = insightsData(BOTH);
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    fireEvent.press(screen.getByText('Salary'));
    expect(mockPush).toHaveBeenCalledWith('/category/salary?cycle=0');
  });

  it('Earning with spend but no income sources shows the empty message, not a category row', () => {
    // Old server (or all sources net ~$0): earned lifted but no per-source map. The toggle still
    // shows because spend is present; the Earning side is an honest empty, not a dead end.
    mockInsights = insightsData({ breakdown: { coffee: { posted: 40, pending: 0 } }, earned: 3000, incomeSources: [] });
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('No income yet this pay cycle.')).toBeTruthy();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
  });

  it('shows a pending sub-line and a reversed (clawed-back) source correctly', () => {
    mockInsights = insightsData({
      breakdown: { coffee: { posted: 40, pending: 0 } },
      earned: 3150,
      incomeSources: [
        { id: 'salary', posted: 3000, pending: 250, amount: 3250 },
        { id: 'dividends', posted: -100, pending: 0, amount: -100 },
      ],
    });
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('$250 pending')).toBeTruthy();      // positive pending sub-line
    expect(screen.getByText('-$100')).toBeTruthy();             // clawback renders signed
  });

  it('falls back to an "Income" label when the taxonomy lacks the source id', () => {
    mockInsights = insightsData({
      breakdown: { coffee: { posted: 40, pending: 0 } },
      earned: 200,
      incomeSources: [{ id: 'mystery', posted: 200, pending: 0, amount: 200 }],
    });
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('Income')).toBeTruthy();
  });

  it('income-only cycle: toggle shows; default Spending reads empty; Earning lists the income', () => {
    mockInsights = insightsData({ breakdown: {}, earned: 3000, incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }] });
    render(<Insights />);
    expect(screen.getByTestId('insights-side-earning')).toBeTruthy();           // toggle shows (income present)
    expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();    // default Spending is honest-empty
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    expect(screen.getByText('Salary')).toBeTruthy();
  });

  it('no toggle and no drill press targets when the cycle is fully empty', () => {
    mockInsights = insightsData({ breakdown: {}, earned: 0, incomeSources: [] });
    render(<Insights />);
    expect(screen.queryByTestId('insights-side-spending')).toBeNull();          // nothing to switch to
    expect(screen.queryByTestId('insights-side-earning')).toBeNull();
    expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
    expect(screen.queryByTestId('earned-bar-press')).toBeNull();                // card is summary-only
    expect(screen.queryByTestId('spent-bar-press')).toBeNull();
  });
});
