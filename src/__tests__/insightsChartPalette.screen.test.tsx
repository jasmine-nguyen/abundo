// WHIT-402 — the Insights pie + its category rows must paint from each category's PERSISTED
// colorSlot, not from the id-derived colour. The `shopping` fixture carries a slot it does NOT own
// (2, not its seed 13) on purpose: the two paths then give different hues (#b5bb51 vs #25cdbd), so
// these assertions redden if the screen stops passing the slot through.
// WHIT-432 forced this. The fixture used to rely on shopping's SEED slot differing from its
// id-derived colour, but that gap was the bug WHIT-432 closed — every built-in now agrees, so a
// seed-slot exemplar would let this suite pass even with the wiring deleted. A slot the category
// does not own tests the sharper contract (the screen forwards whatever the server sent) and
// survives any future re-space of the seed table.
// The last test covers the other half: a category with NO slot must still render a sane chart.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';
import { PALETTE_CATS } from './insightsColourFixtures';

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
// `shopping` carries slot 2 — NOT its seed slot 13 — so the stored path (#b5bb51) and the id
// fallback (#25cdbd) disagree. That disagreement is the whole point: it is what reddens if the
// screen stops forwarding the slot. See the header for why a seed slot no longer works here.
const CATS = PALETTE_CATS;
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
    // slot 2 -> ramp 5. NOT #25cdbd, which is what the id-derived fallback would give — so this
    // assertion is what proves the screen reads the stored slot.
    expect(shopping?.color).toBe('#b5bb51');
    expect(eatingout?.color).toBe('#f98f98'); // slot 0 -> ramp 0
  });

  it('paints the category row bars with the ramp colours too', () => {
    render(<Insights />);
    const tree = screen.toJSON();
    expect(hasFillColor(tree, '#b5bb51')).toBe(true); // shopping bar = its SLOT colour
    expect(hasFillColor(tree, '#f98f98')).toBe(true); // eatingout bar = its slot colour
    // the old app-wide colours are gone
    expect(hasFillColor(tree, '#73daca')).toBe(false);
    expect(hasFillColor(tree, '#e5495f')).toBe(false);
    // and so is shopping's id-derived fallback — the slot won
    expect(hasFillColor(tree, '#25cdbd')).toBe(false);
  });

  it('falls back to the id-derived colours for a category the server has not slotted yet', () => {
    // The deploy-ordering guarantee: this client can ship before the server does. Every category
    // then arrives with no slot, and the chart must render the id-derived palette rather than going
    // blank or one flat colour. NOT "exactly as it does today": WHIT-432 moved three built-in
    // fallbacks onto the server's positions, so the fallback chart is deliberately not the shipped
    // one any more.
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
    expect(shopping?.color).toBe('#25cdbd');   // shopping's id-derived colour
    expect(eatingout?.color).toBe('#f98f98');
    // and never the "no slot means slot 0" bug, which would paint BOTH the same pink
    expect(shopping?.color).not.toBe(eatingout?.color);
  });
});
