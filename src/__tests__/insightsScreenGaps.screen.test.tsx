// WHIT-189 GAPS (adversarial half, authored by qa) — the composite hook is MOCKED here
// (deterministic breakdown/error/loading states); the AI card reads the real-selector
// context store. Complements InsightsScreen.screen.test.tsx (happy path) by pinning the
// three states of the hero apart and proving the breakdown and AI features are visually
// INDEPENDENT — one failing must not hide/alter the other. Same mock pattern as
// InsightsScreen.screen.test.tsx.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockInsights: ReturnType<typeof insightsData>;
jest.mock('../queries', () => ({ useInsightsScreenData: () => mockInsights, useGoalScreenData: () => ({ loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null }, homeLoan: { balance: null, asOf: null }, repayment: { amount: null, date: null, principal: null, interest: null }, isLoading: false, isError: false, homeLoanError: false, refetch: jest.fn(), refetchStale: jest.fn() }) }));

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]) };
});

import Insights from '../../app/(tabs)/insights';
import { UNCATEGORIZED_KEY } from '../context';

const refreshAiInsights = jest.fn();
const generateAiInsights = jest.fn();
const refetch = jest.fn();
const refetchStale = jest.fn();

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 0 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;

const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }>; isLoading: boolean; isError: boolean; categoriesError: boolean; category: (id: string) => unknown }>) {
  return { breakdown: {}, category, isLoading: false, isError: false, categoriesError: false, refetch, refetchStale, ...over };
}

function state(over: Partial<AppContext>): AppContext {
  return {
    aiInsights: null,
    aiInsightsLoading: false,
    aiInsightsError: false,
    refreshAiInsights,
    generateAiInsights,
    loanFacts: NO_LOAN_FACTS,
    homeLoan: { balance: null, asOf: null },
    ...over,
  } as unknown as AppContext;
}

beforeEach(() => {
  refreshAiInsights.mockClear();
  generateAiInsights.mockClear();
  refetch.mockClear();
  refetchStale.mockClear();
  mockInsights = insightsData({});
  mockState = state({});
});

// --- the three hero states, pinned apart (loaded-empty must NOT be suppressed) ---

describe('hero state: legit zero-spend cycle', () => {
  it('a loaded, empty breakdown (no error, not loading) shows a real $0 / 0 categories — NOT suppressed to "—"', () => {
    mockInsights = insightsData({ breakdown: {}, isLoading: false, isError: false });
    render(<Insights />);
    // The whole point of the WHIT-189 hero fix: only a load/error hides the number.
    // A genuine zero-spend cycle is real data and must read $0, not the "—" placeholder.
    expect(screen.getByText('$0')).toBeTruthy();
    expect(screen.getByText(/across 0 categories/)).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByText("Couldn't load")).toBeNull();
    expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
  });
});

describe('hero state: loading vs error placeholders (no false $0)', () => {
  it('loading (nothing cached) → hero reads "—" / "Loading…", never $0', () => {
    mockInsights = insightsData({ breakdown: {}, isLoading: true });
    render(<Insights />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('error (nothing cached) → hero reads "—" / "Couldn\'t load", never $0', () => {
    mockInsights = insightsData({ breakdown: {}, isError: true });
    render(<Insights />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText("Couldn't load")).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
  });
});

// --- WHIT-194: a first-load categories failure suppresses the partial hero ---

describe('categoriesError: first-load taxonomy failure surfaces the error, not a partial hero', () => {
  it('breakdown has an Uncategorized row but categoriesError is set → error shown, no partial row/total leaks', () => {
    // The composite reports categoriesError (categories failed with no cached taxonomy).
    // Even though a taxonomy-free Uncategorized row survives in the breakdown, the screen
    // must show the error and suppress that row — never a hero total that omits real spend.
    mockInsights = insightsData({
      breakdown: { [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 } },
      category: () => undefined, // taxonomy unavailable
      isError: true,
      categoriesError: true,
    });
    render(<Insights />);
    expect(screen.getByTestId('insights-error')).toBeTruthy();   // error surfaces
    expect(screen.getByText("Couldn't load")).toBeTruthy();      // hero says so
    expect(screen.queryByText('Uncategorized')).toBeNull();      // partial row suppressed by !showError gate
    expect(screen.queryByText('$25')).toBeNull();                // no partial total
  });
});

// --- WHIT-194: isError with rows still cached must NOT hide the rows (cache-first) ---

describe('cache-first: an errored refetch over good cached rows keeps the rows, no error card', () => {
  it('isError true + a surviving row + categoriesError false → row + total show, NO "Couldn\'t load"', () => {
    // The paired render-level lock for insightsBreakdownCacheFirst (which proves the hook
    // surfaces isError while v5 retains breakdown data). Here the composite reports isError
    // over a still-cached Uncategorized row with categoriesError=false — exactly a failed
    // background refetch. showError = (isError && rows.length === 0) || categoriesError must
    // be FALSE, so the row survives. Fail-on-revert: dropping the `&& rows.length === 0`
    // guard (showError = isError || categoriesError) blanks the row and shows the error here.
    mockInsights = insightsData({
      breakdown: { [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 } },
      isError: true,
      categoriesError: false,
    });
    render(<Insights />);
    expect(screen.queryByTestId('insights-error')).toBeNull();     // no error card over cached rows
    expect(screen.queryByText("Couldn't load")).toBeNull();        // hero keeps its number, not "—"
    expect(screen.getByText('Uncategorized')).toBeTruthy();        // the cached row survives
    expect(screen.getAllByText('$25').length).toBeGreaterThanOrEqual(1); // hero + row total intact
  });
});

// --- breakdown and AI are independent features on one screen -----------------

describe('breakdown error does NOT break the AI card', () => {
  it('breakdown in error (rows gone, hero "—") while AI advice exists → AI card still fully renders', () => {
    mockInsights = insightsData({ breakdown: {}, isError: true });
    mockState = state({
      aiInsights: { summary: 'You are pacing well.', suggestions: ['Trim $20 from Coffee'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    });
    render(<Insights />);
    // breakdown side is in its error state...
    expect(screen.getByTestId('insights-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load")).toBeTruthy();
    // ...but the AI coach card is untouched.
    expect(screen.getByText('You are pacing well.')).toBeTruthy();
    expect(screen.getByText('Trim $20 from Coffee')).toBeTruthy();
    expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy();
  });
});

describe('AI error does NOT hide the breakdown rows', () => {
  it('AI generation failed while breakdown has spend → rows + real hero total still show', () => {
    mockInsights = insightsData({ breakdown: { coffee: { posted: 30, pending: 0 } }, isError: false });
    mockState = state({ aiInsights: null, aiInsightsError: true });
    render(<Insights />);
    // AI side shows its own failure...
    expect(screen.getByText(/Couldn’t generate insights/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    // ...and the breakdown rows + hero are unaffected (real $30, not "—").
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    // $30 appears twice (hero total + row amount); the load/error placeholder does not.
    expect(screen.getAllByText('$30').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByTestId('insights-error')).toBeNull();
  });
});
