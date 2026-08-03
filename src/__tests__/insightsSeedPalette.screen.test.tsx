// WHIT-415 — [A8]-[A11] the END-TO-END proof: a category carrying the slot the SERVER really seeds
// paints the re-spaced colour through the real screen (app/(tabs)/insights.tsx -> SpendingDonut).
//
// insightsChartPalette.screen.test.tsx already proves the slot is READ at all, but it does so with
// a hand-typed `colorSlot: 4` that the server no longer assigns to anything. This file takes the
// slots out of shared/repository_category.py itself, so the screen is asserted against the table
// production actually ships — and the top-three-by-spend scenario the card was raised for is the
// scenario under test.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';
import { CATEGORY_COLORS, ASSIGNMENT_ORDER } from '../chartColors';
import { readServerSeedSlots } from './serverSeedSlots';

const SEED = readServerSeedSlots();
const rampOf = (hex: string) => CATEGORY_COLORS.indexOf(hex as never);

type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

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

// Every category carries the slot the SERVER seeds it with — no hand-typed mirror. `color` is the
// stale app-wide hue on purpose: the screen must overwrite it from the slot.
const NAMES: Record<string, string> = {
  eatingout: 'Eating Out', health: 'Health', coffee: 'Cafes & Coffee', utilities: 'Utilities',
  groceries: 'Groceries', transport: 'Transport',
};
const category = (id: string) =>
  (SEED[id] === undefined ? undefined : {
    id, name: NAMES[id] ?? id, icon: 'tag', color: '#ff0000',
    bucket: 'Living', recent: 0, parent: null, colorSlot: SEED[id],
  }) as never;

const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };
const posted = (n: number) => ({ posted: n, pending: 0 });

function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }> }>) {
  return { breakdown: {}, earned: 0, incomeSources: [], category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over };
}

const paint = (id: string) => capturedSlices.find((s) => s.id === id)?.color as string;

beforeEach(() => {
  capturedSlices = [];
  mockState = {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null },
  };
  // THE card's scenario: Eating Out, Health and Coffee are the top three by spend.
  mockInsights = insightsData({
    breakdown: { eatingout: posted(300), health: posted(200), coffee: posted(100) },
  });
});

describe('Insights paints the server-seeded slots', () => {
  it('[A8] the top three by spend are not three neighbouring hues', () => {
    render(<Insights />);
    const ramps = ['eatingout', 'health', 'coffee'].map((id) => rampOf(paint(id)));
    for (const r of ramps) expect(r).toBeGreaterThanOrEqual(0);   // a real ramp colour, not undefined
    expect(new Set(ramps).size).toBe(3);
    // the reported bug was three CONSECUTIVE ramp entries; coffee must clear both others by >1
    expect(Math.abs(ramps[2] - ramps[1])).toBeGreaterThan(1);
    expect(Math.abs(ramps[2] - ramps[0])).toBeGreaterThan(1);
  });

  it('[A9] coffee paints its re-spaced hue, not the salmon it used to', () => {
    render(<Insights />);
    expect(paint('coffee')).toBe(CATEGORY_COLORS[ASSIGNMENT_ORDER[SEED.coffee]]);
    expect(paint('coffee')).toBe('#e8a24f');       // ramp 3 (amber), NOT ramp 2's #f49964
    expect(paint('eatingout')).toBe('#f98f98');    // ramp 0, unchanged
    expect(paint('health')).toBe('#f9927e');       // ramp 1, unchanged
  });

  it('[A10] every OTHER built-in keeps the hue it already had — exactly one slot moved', () => {
    // The re-space deliberately moves coffee and nothing else: each extra move shifts which slot is
    // lowest-free, which silently changes the colour a user's first custom category gets. Utilities
    // is the one that was nearly moved too, so it is asserted by name.
    mockInsights = insightsData({
      breakdown: { utilities: posted(300), groceries: posted(200), eatingout: posted(100) },
    });
    render(<Insights />);
    expect(paint('utilities')).toBe(CATEGORY_COLORS[ASSIGNMENT_ORDER[SEED.utilities]]);
    expect(paint('utilities')).toBe('#d2ae45');    // ramp 4 — unchanged by this card
    expect(paint('groceries')).toBe('#8ec56f');    // ramp 6 — unchanged
  });

  it('[A11] the ring is still STRICTLY spend-ordered — recolouring added no re-ordering pass', () => {
    // WHIT-403 deleted the warm/cool re-ordering pass on purpose; the spoken accessibility
    // summary reads the ring in this order. A re-space must never tempt it back.
    mockInsights = insightsData({
      breakdown: {
        coffee: posted(10), eatingout: posted(300), utilities: posted(50),
        health: posted(200), groceries: posted(120),
      },
    });
    render(<Insights />);
    expect(capturedSlices.map((s) => s.id)).toEqual(['eatingout', 'health', 'groceries', 'utilities', 'coffee']);
    expect(capturedSlices.map((s) => s.value)).toEqual([300, 200, 120, 50, 10]);
  });
});
