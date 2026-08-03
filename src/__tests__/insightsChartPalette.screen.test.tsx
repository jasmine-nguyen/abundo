// WHIT-402 — the Insights pie + its category rows must paint from each category's PERSISTED
// colorSlot, not from the id-derived colour. The `shopping` fixture is deliberate: it is one of
// only three built-ins whose slot-derived and id-derived colours DIFFER (#25cdbd vs #4ccda3), so these
// assertions redden if the screen stops passing the slot. A category whose two paths agree (e.g.
// groceries) would let this suite pass even if the wiring were never written.
// The last test covers the other half of the contract: a category with NO slot — a client running
// ahead of the server — must still render exactly today's colours.
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
// `shopping` is deliberate: it is one of the three built-ins whose colour MOVES when the chart
// paints from the stored slot (#4ccda3 id-derived -> #25cdbd slot-derived). A category whose two
// paths agree would let this suite pass even if the slot wiring were never written. WHIT-415 moved
// coffee INTO the agreeing set, which is why it is no longer the exemplar here.
const CATS = [
  { id: 'shopping', name: 'Shopping', icon: 'bag', color: '#73daca', bucket: 'Lifestyle', recent: 0, colorSlot: 13 },
  { id: 'eatingout', name: 'Eating Out', icon: 'food', color: '#e5495f', bucket: 'Lifestyle', recent: 0, colorSlot: 0 },
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
  mockInsights = insightsData({ breakdown: { shopping: { posted: 80, pending: 0 }, eatingout: { posted: 40, pending: 0 } } });
});

describe('Insights recolours the pie + rows from the chart palette', () => {
  it('paints the donut slices with the ramp colours, not the old category hues', () => {
    render(<Insights />);
    const shopping = capturedSlices.find((s) => s.id === 'shopping');
    const eatingout = capturedSlices.find((s) => s.id === 'eatingout');
    // slot 13 -> ramp 9. NOT #4ccda3, which is what the id-derived fallback would give — so this
    // assertion is what proves the screen reads the stored slot.
    expect(shopping?.color).toBe('#25cdbd');
    expect(eatingout?.color).toBe('#f98f98'); // slot 0 -> ramp 0
  });

  it('paints the category row bars with the ramp colours too', () => {
    render(<Insights />);
    const tree = screen.toJSON();
    expect(hasFillColor(tree, '#25cdbd')).toBe(true); // shopping bar = its SLOT colour
    expect(hasFillColor(tree, '#f98f98')).toBe(true); // eatingout bar = its slot colour
    // the old app-wide colours are gone
    expect(hasFillColor(tree, '#73daca')).toBe(false);
    expect(hasFillColor(tree, '#e5495f')).toBe(false);
    // and so is shopping's id-derived fallback — the slot won
    expect(hasFillColor(tree, '#4ccda3')).toBe(false);
  });

  it('falls back to today\'s colours for a category the server has not slotted yet', () => {
    // The deploy-ordering guarantee: this client can ship before the server does. Every category
    // then arrives with no slot, and the chart must render EXACTLY as it does today rather than
    // going blank or one flat colour.
    mockInsights = insightsData({
      breakdown: { shopping: { posted: 80, pending: 0 }, eatingout: { posted: 40, pending: 0 } },
    });
    // strip the slots the way a pre-slot server would
    (mockInsights as { category: (id: string) => unknown }).category = (id: string) => {
      const found = CATS.find((c) => c.id === id);
      if (!found) return undefined;
      const { colorSlot, ...withoutSlot } = found;
      return withoutSlot;
    };
    render(<Insights />);

    const shopping = capturedSlices.find((s) => s.id === 'shopping');
    const eatingout = capturedSlices.find((s) => s.id === 'eatingout');
    expect(shopping?.color).toBe('#4ccda3');   // shopping's id-derived colour — today's chart
    expect(eatingout?.color).toBe('#f98f98');
    // and never the "no slot means slot 0" bug, which would paint BOTH the same pink
    expect(shopping?.color).not.toBe(eatingout?.color);
  });
});
