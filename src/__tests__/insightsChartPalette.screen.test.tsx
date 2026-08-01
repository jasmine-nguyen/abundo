// WHIT chart palette — the Insights pie + its category rows must render the NEW 20-colour ramp, not
// the app-wide colorForCategory hues. The screen wraps the category accessor so both the donut slices
// and the row bars/chips read the ramp colour. This proves that wiring end-to-end: the mock category
// carries the OLD colours (groceries #9ece6a, eatingout #e5495f); if the wrapper were removed the pie
// and rows would show those, so asserting the ramp hexes is fail-on-revert.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';

type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

// Capture the slices the donut is handed, so we can assert their colours directly.
let capturedSlices: { id: string; name: string; color: string; value: number }[] = [];
jest.mock('../components/SpendingDonut', () => ({
  SpendingDonut: (props: { slices: { id: string; name: string; color: string; value: number }[] }) => {
    capturedSlices = props.slices;
    return null;
  },
}));

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
const CATS = [
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#9ece6a', bucket: 'Living', recent: 0 },
  { id: 'eatingout', name: 'Eating Out', icon: 'food', color: '#e5495f', bucket: 'Lifestyle', recent: 0 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;
const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }>; earned: number; incomeSources: { id: string; posted: number; pending: number; amount: number }[]; isLoading: boolean; isError: boolean }>) {
  return { breakdown: {}, earned: 0, incomeSources: [], category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}

// Walk the tree for a View filled with `hex`.
function hasFillColor(node: unknown, hex: string): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => hasFillColor(n, hex));
  const n = node as { props?: { style?: unknown }; children?: unknown[] };
  const flat = StyleSheet.flatten(n.props?.style as never) || {};
  if ((flat as { backgroundColor?: string }).backgroundColor === hex) return true;
  return Array.isArray(n.children) && n.children.some((c) => hasFillColor(c, hex));
}

beforeEach(() => {
  capturedSlices = [];
  mockState = {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null },
  };
  mockInsights = insightsData({ breakdown: { groceries: { posted: 80, pending: 0 }, eatingout: { posted: 40, pending: 0 } } });
});

describe('Insights recolours the pie + rows from the chart palette', () => {
  it('paints the donut slices with the ramp colours, not the old category hues', () => {
    render(<Insights />);
    const groceries = capturedSlices.find((s) => s.id === 'groceries');
    const eatingout = capturedSlices.find((s) => s.id === 'eatingout');
    expect(groceries?.color).toBe('#8ec56f'); // ramp slot 6, not old #9ece6a
    expect(eatingout?.color).toBe('#f98f98'); // ramp slot 0, not old #e5495f
  });

  it('paints the category row bars with the ramp colours too', () => {
    render(<Insights />);
    const tree = screen.toJSON();
    expect(hasFillColor(tree, '#8ec56f')).toBe(true); // groceries bar = ramp colour
    expect(hasFillColor(tree, '#f98f98')).toBe(true); // eatingout bar = ramp colour
    // and the OLD colours are gone from the screen
    expect(hasFillColor(tree, '#9ece6a')).toBe(false);
    expect(hasFillColor(tree, '#e5495f')).toBe(false);
  });
});
