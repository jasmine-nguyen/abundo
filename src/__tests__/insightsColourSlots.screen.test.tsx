// Insights colour/slot painting — data-layer-mocked suites merged (WHIT-451) from
// insightsChartPalette + insightsSeedPalette + insightsSlotRows. All three mock
// ../components/SpendingDonut (to capture the slices handed to the pie), ../queries, ../context
// and expo-router byte-identically, so they share this one preamble; each suite keeps its own
// scoped fixtures + beforeEach below.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';
import { CATEGORY_COLORS, ASSIGNMENT_ORDER, chartCategoryColor } from '../chartColors';
import { PALETTE_CATS, SLOT_ROWS_CATS } from './insightsColourFixtures';
import { readServerSeedSlots } from './serverSeedSlots';

type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

// Capture the slices the donut is handed, so each suite can assert their colours directly.
let capturedSlices: { id: string; name: string; color: string; value: number }[] = [];
jest.mock('../components/SpendingDonut', () => ({
  SpendingDonut: (props: { slices: { id: string; name: string; color: string; value: number }[] }) => {
    capturedSlices = props.slices;
    return null;
  },
}));

// Typed `unknown` because the merged suites feed differently-shaped insightsData(); consumers are
// typed by the real ../queries.
let mockInsights: unknown;
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

describe('Insights chart palette (WHIT-402/432)', () => {
  // PALETTE_CATS carry the OLD app-wide colours (the wrapper must override them with the ramp), and
  // `shopping` carries slot 2 — NOT its seed slot 13 — so the stored path (#b5bb51) and the id
  // fallback (#25cdbd) disagree. That disagreement is the whole point: it reddens if the screen stops
  // forwarding the slot. (WHIT-432 aligned every built-in's fallback with its seed, so a seed-slot
  // fixture would let this pass even with the wiring deleted.)
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
});

describe('Insights server-seeded slots (WHIT-415)', () => {
  // Every category carries the slot the SERVER really seeds it with (read from
  // shared/repository_category.py, no hand-typed mirror); `color` is a stale app-wide hue on purpose,
  // so the screen must overwrite it from the slot.
  const SEED = readServerSeedSlots();
  const rampOf = (hex: string) => CATEGORY_COLORS.indexOf(hex as never);
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
});

describe('Insights slot rows (WHIT-402)', () => {
  // SLOT_ROWS_CATS: a parent with its OWN direct spend (-> a "Directly in X" row), one spending child,
  // and one net-refunded child (-> a refund line). Every mock category carries a WRONG app-wide colour,
  // so a screen that forgot to wrap the colour accessor at all also fails. shopping slot 2 -> #b5bb51,
  // shoes slot 5 -> #6eca89, clothes slot 9 -> #e8a24f (all distinct, so no assertion passes by accident).
  const CATS = SLOT_ROWS_CATS;
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
      // The parent slice itself first: slot 2, never shopping's id-derived #25cdbd.
      expect(capturedSlices.find((s) => s.id === 'shopping')?.color).toBe('#b5bb51');
      fireEvent.press(screen.getByText('Shopping'));     // expand to reveal the subtree
  
      const tree = screen.toJSON();
      // The indent stripe on the synthetic row is its colour, and it must equal the PARENT's slot hue.
      expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).toBe('#b5bb51');
      expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).toBe(chartCategoryColor('shopping', { slot: 2 }));
      // never a hash of the SYNTHETIC id, and never the parent's slot-less fallback
      expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).not.toBe(chartCategoryColor('shopping__direct'));
      expect(styleValues(tree, 'borderLeftColor')).not.toContain('#25cdbd');
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
      expect(new Set(['#b5bb51', '#6eca89', '#e8a24f']).size).toBe(3);
      // no row is ever painted with an undefined / missing colour
      for (const value of styleValues(tree, 'borderLeftColor')) expect(value).toMatch(/^#|^rgba/);
    });
  
    it('[A12] every one of these rows still falls back to the id-derived colours when the server has no slots', () => {
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
      expect(capturedSlices.find((s) => s.id === 'shopping')?.color).toBe('#25cdbd'); // id-derived
      fireEvent.press(screen.getByText('Shopping'));
      const tree = screen.toJSON();
      expect(rowStyle(tree, 'Directly in Shopping', 'borderLeftColor')).toBe('#25cdbd');
      expect(rowStyle(tree, 'Shoes', 'borderLeftColor')).toBe('#e991cc');
      expect(rowStyle(tree, 'Clothes', 'borderLeftColor')).toBe('#bf9ff8');
      // the "absent slot means slot 0" bug would paint all three the same pink
      expect(styleValues(tree, 'borderLeftColor')).not.toContain('#f98f98');
    });
  });
  
  describe('WHIT-402 — the Earning tab falls back when a source has no slot', () => {
    it('[A13] a slot-less income source keeps its id-derived colour, never slot 0\'s pink', () => {
      // The Spending side has this test (insightsChartPalette "falls back to the id-derived colours"); the
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
  
      expect(backgrounds).toContain(chartCategoryColor('salary'));  // #25cdbd — salary's id-derived hue
      expect(backgrounds).toContain('#25cdbd');
      expect(backgrounds).not.toContain('#123456');                 // never the old app-wide hue
      expect(backgrounds).not.toContain('#f98f98');                 // never "no slot == slot 0"
    });
  });
});
