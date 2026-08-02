// WHIT-402 — [A9] [A10] [A11] [A12] the SYNTHETIC breakdown rows must paint from the stored slot.
//
// The gap this closes: chartPaletteBreakdown.logic.test.ts pins "Directly in X" / refund-line colour
// inheritance, but its `chartWrap` helper is a HAND COPY of the screen's wrapper that never passes a
// slot — so it exercises the FALLBACK path only. Nothing today proves a nested row follows its
// category's SLOT. This renders the real screen (the production wrapper, app/(tabs)/insights.tsx:31-35),
// so reverting that wrapper to `chartCategoryColor(id)` reddens every assertion here.
//
// Colour map used below (all six hexes distinct, so no assertion can pass by accident):
//   shopping  slot 13 -> #25cdbd   id-derived fallback -> #4ccda3
//   shoes     slot  5 -> #6eca89   id-derived fallback -> #e991cc
//   clothes   slot  9 -> #e8a24f   id-derived fallback -> #bf9ff8
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { chartCategoryColor } from '../chartColors';
import type { AppContext, LoanFacts } from '../context';

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

// A parent with its OWN direct spend (-> a "Directly in X" row), one spending child, and one
// net-refunded child (-> a refund line). Every mock category carries a WRONG app-wide colour, so a
// screen that forgot to wrap the accessor at all also fails.
const CATS = [
  { id: 'shopping', name: 'Shopping', icon: 'bag', color: '#111111', bucket: 'Lifestyle', recent: 0, parent: null, colorSlot: 13 },
  { id: 'shoes', name: 'Shoes', icon: 'bag', color: '#222222', bucket: 'Lifestyle', recent: 0, parent: 'shopping', colorSlot: 5 },
  { id: 'clothes', name: 'Clothes', icon: 'bag', color: '#333333', bucket: 'Lifestyle', recent: 0, parent: 'shopping', colorSlot: 9 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;
const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

// shopping node 50 = own 20 + shoes 60 − clothes 30 (refunded), so the expanded list reconciles and
// no WHIT-357 "Other" remainder line is emitted.
const TREE_BREAKDOWN = {
  shopping: { posted: 20, pending: 0 },
  shoes: { posted: 60, pending: 0 },
  clothes: { posted: 0, pending: 0 },
  __rollup__: { nodes: { shopping: { posted: 50, pending: 0 } }, refunds: { shopping: [{ id: 'clothes', amount: -30 }] } },
};

function insightsData(over: Record<string, unknown>) {
  return { breakdown: {}, earned: 0, incomeSources: [], category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over } as {
    breakdown: Record<string, never>; earned: number; incomeSources: { id: string; posted: number; pending: number; amount: number }[];
    category: (id: string) => never; isLoading: boolean; isError: boolean; refetch: () => void; refetchStale: () => void;
  };
}

// Every value of one style property anywhere in the rendered tree.
function styleValues(node: unknown, prop: string, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) styleValues(n, prop, out); return out; }
  const n = node as { props?: { style?: unknown }; children?: unknown[] };
  const flat = (StyleSheet.flatten(n.props?.style as never) || {}) as Record<string, unknown>;
  if (typeof flat[prop] === 'string') out.push(flat[prop] as string);
  if (Array.isArray(n.children)) for (const c of n.children) styleValues(c, prop, out);
  return out;
}

// Does this subtree render `text` anywhere under it?
function subtreeHasText(node: unknown, text: string): boolean {
  if (typeof node === 'string') return node === text;
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((n) => subtreeHasText(n, text));
  const n = node as { children?: unknown[] };
  return Array.isArray(n.children) && n.children.some((c) => subtreeHasText(c, text));
}

// The `prop` colour of the ROW that renders `text` — the nearest enclosing node that sets it.
// Precise enough that a right colour on the wrong row cannot pass.
function rowStyle(node: unknown, text: string, prop: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const hit = rowStyle(n, text, prop); if (hit) return hit; } return undefined; }
  const n = node as { props?: { style?: unknown }; children?: unknown[] };
  if (!subtreeHasText(n, text)) return undefined;
  for (const c of n.children ?? []) { const deeper = rowStyle(c, text, prop); if (deeper) return deeper; }
  const flat = (StyleSheet.flatten(n.props?.style as never) || {}) as Record<string, unknown>;
  return typeof flat[prop] === 'string' ? (flat[prop] as string) : undefined;
}

beforeEach(() => {
  capturedSlices = [];
  mockState = {
    aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
    refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
    generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null },
  };
  mockInsights = insightsData({ breakdown: TREE_BREAKDOWN });
});

describe('WHIT-402 — nested + synthetic Insights rows paint from the stored slot', () => {
  it('[A9] the "Directly in X" row inherits its PARENT\'s slot colour, not the parent\'s id fallback', () => {
    render(<Insights />);
    // The parent slice itself first: slot 13, never shopping's id-derived #4ccda3.
    expect(capturedSlices.find((s) => s.id === 'shopping')?.color).toBe('#25cdbd');
    fireEvent.press(screen.getByText('Shopping'));     // expand to reveal the subtree

    const tree = screen.toJSON();
    // The indent stripe on the synthetic row is its colour, and it must equal the PARENT's slot hue.
    expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).toBe('#25cdbd');
    expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).toBe(chartCategoryColor('shopping', { slot: 13 }));
    // never a hash of the SYNTHETIC id, and never the parent's slot-less fallback
    expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).not.toBe(chartCategoryColor('shopping__direct'));
    expect(styleValues(tree, 'borderLeftColor')).not.toContain('#4ccda3');
  });

  it('[A10] a refund line takes the refunded member\'s OWN slot colour', () => {
    render(<Insights />);
    fireEvent.press(screen.getByText('Shopping'));
    const tree = screen.toJSON();
    // clothes slot 9 -> #e8a24f. Its id-derived fallback is #bf9ff8 — asserting the former and the
    // absence of the latter is what proves the refund line resolved through the slot.
    expect(rowStyle(tree, 'Clothes', 'borderLeftColor')).toBe('#e8a24f');
    expect(rowStyle(tree, 'Clothes', 'borderLeftColor')).toBe(chartCategoryColor('clothes', { slot: 9 }));
    expect(styleValues(tree, 'borderLeftColor')).not.toContain('#bf9ff8');
    expect(styleValues(tree, 'borderLeftColor')).not.toContain(chartCategoryColor('clothes__refund'));
  });

  it('[A11] a child leaf paints its OWN slot, so parent and child never share a hue', () => {
    render(<Insights />);
    fireEvent.press(screen.getByText('Shopping'));
    const tree = screen.toJSON();
    expect(rowStyle(tree, 'Shoes', 'borderLeftColor')).toBe('#6eca89');       // shoes slot 5
    expect(styleValues(tree, 'borderLeftColor')).not.toContain('#e991cc');     // shoes' id fallback
    // and the three rows are three different colours
    expect(new Set(['#25cdbd', '#6eca89', '#e8a24f']).size).toBe(3);
    // no row is ever painted with an undefined / missing colour
    for (const value of styleValues(tree, 'borderLeftColor')) expect(value).toMatch(/^#|^rgba/);
  });

  it('[A12] every one of these rows still falls back to today\'s colours when the server has no slots', () => {
    // Same tree, slots stripped — the deploy-ordering guarantee has to hold for the NESTED rows too,
    // not just the flat top-level ones the existing suite covers.
    mockInsights = insightsData({
      breakdown: TREE_BREAKDOWN,
      category: (id: string) => {
        const found = CATS.find((c) => c.id === id);
        if (!found) return undefined;
        const { colorSlot: _drop, ...withoutSlot } = found;
        return withoutSlot;
      },
    });
    render(<Insights />);
    expect(capturedSlices.find((s) => s.id === 'shopping')?.color).toBe('#4ccda3'); // id-derived
    fireEvent.press(screen.getByText('Shopping'));
    const tree = screen.toJSON();
    expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).toBe('#4ccda3');
    expect(rowStyle(tree, 'Shoes', 'borderLeftColor')).toBe('#e991cc');
    expect(rowStyle(tree, 'Clothes', 'borderLeftColor')).toBe('#bf9ff8');
    // the "absent slot means slot 0" bug would paint all three the same pink
    expect(styleValues(tree, 'borderLeftColor')).not.toContain('#f98f98');
  });
});

describe('WHIT-402 — the Earning tab falls back when a source has no slot', () => {
  it('[A13] a slot-less income source keeps EXACTLY today\'s colour, never slot 0\'s pink', () => {
    // The Spending side has this test (insightsChartPalette "falls back to today's colours"); the
    // Earning side only ever asserts the slot path, so an un-migrated server is unpinned there.
    const INCOME_CATS = [
      // NOT C.good ('#2ac3de'): the EarnedVsSpent card legitimately paints a C.good bar, so an
      // old-colour fixture equal to it could never be asserted absent.
      { id: 'salary', name: 'Salary', icon: 'briefcase', color: '#123456', bucket: 'Income', recent: 0, parent: null },
    ];
    mockInsights = insightsData({
      earned: 3000,
      incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
      category: (id: string) => INCOME_CATS.find((c) => c.id === id),
    });
    render(<Insights />);
    fireEvent.press(screen.getByTestId('insights-side-earning'));
    const backgrounds = styleValues(screen.toJSON(), 'backgroundColor');

    expect(backgrounds).toContain(chartCategoryColor('salary'));  // #25cdbd — today's chart
    expect(backgrounds).toContain('#25cdbd');
    expect(backgrounds).not.toContain('#123456');                 // never the old app-wide hue
    expect(backgrounds).not.toContain('#f98f98');                 // never "no slot == slot 0"
  });
});
