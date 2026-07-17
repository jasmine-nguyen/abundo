// Screen test: the Insights tab. Breakdown (spend-by-category) now comes from the
// query layer (WHIT-189) — the `useInsightsScreenData` composite is mocked here to feed
// controlled breakdown/state; the AI-insights feature still reads the context store
// (`useAppContext`), mocked as before. The real `categoryBreakdown` selector runs over
// the mocked breakdown. Real query behaviour (fetch/self-heal/auth-gate) is covered by
// insightsBreakdownQuery.screen.test.tsx.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext, LoanFacts } from '../context';
import { UNCATEGORIZED_KEY } from '../context';

// WHIT-192: insights.tsx reads only the AI slice off the store; loanFacts/homeLoan come
// from useGoalScreenData (query layer). The fixture carries the AI slice PLUS loanFacts/
// homeLoan purely to feed the mocked useGoalScreenData below — they're no longer on the store.
type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

// Breakdown data — the query composite.
let mockInsights: ReturnType<typeof insightsData>;
jest.mock('../queries', () => ({ useInsightsScreenData: () => mockInsights, useGoalScreenData: () => ({ loanFacts: mockState.loanFacts, homeLoan: mockState.homeLoan, repayment: { amount: null, date: null, principal: null, interest: null }, isLoading: false, isError: false, homeLoanError: false, refetch: jest.fn(), refetchStale: jest.fn() }) }));

// AI state — the context store.
let mockState: InsightsState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

// Run the focus callback through a real effect so refresh-on-focus is exercised.
jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]) };
});

import Insights from '../../app/(tabs)/insights';

const refreshAiInsights = jest.fn();
const generateAiInsights = jest.fn();
const refetch = jest.fn();
const refetchStale = jest.fn();

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7FD49B', bucket: 'Living', recent: 0 },
] as const;
const category = (id: string) => CATS.find((c) => c.id === id) as never;

const NO_LOAN_FACTS = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };
const READY_LOAN_FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };

// The breakdown query composite.
function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }>; isLoading: boolean; isError: boolean }>) {
  return { breakdown: {}, category, isLoading: false, isError: false, refetch, refetchStale, ...over };
}

// The AI slice of the context store (+ loanFacts/homeLoan the goal-query mock reads).
function state(over: Partial<InsightsState>): InsightsState {
  return {
    aiInsights: null,
    aiInsightsLoading: false,
    aiInsightsError: false,
    refreshAiInsights: refreshAiInsights as AppContext['refreshAiInsights'],
    generateAiInsights: generateAiInsights as AppContext['generateAiInsights'],
    loanFacts: NO_LOAN_FACTS,
    homeLoan: { balance: null, asOf: null },
    ...over,
  };
}

beforeEach(() => {
  refreshAiInsights.mockClear();
  generateAiInsights.mockClear();
  refetch.mockClear();
  refetchStale.mockClear();
  mockInsights = insightsData({});
  mockState = state({});
});

// --- breakdown (WHIT-23 / WHIT-189) ------------------------------------------

it('renders a row per spent category with the pending portion visible', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 5 }, groceries: { posted: 80, pending: 0 } } });
  render(<Insights />);
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Groceries')).toBeTruthy();
  expect(screen.getByText(/\$5 pending/)).toBeTruthy();
});

it('shows the Uncategorized bucket as a row', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 40, pending: 0 }, [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 } } });
  render(<Insights />);
  expect(screen.getByText('Uncategorized')).toBeTruthy();
});

it('shows an empty state when there is no spend', () => {
  mockInsights = insightsData({ breakdown: {} });
  render(<Insights />);
  expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
});

it('draws the spending donut once there is spend, and never over an empty/loading/error state', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 5 }, groceries: { posted: 80, pending: 0 } } });
  const { rerender } = render(<Insights />);
  expect(screen.getByTestId('insights-donut')).toBeTruthy();

  mockInsights = insightsData({ breakdown: {} }); // no spend → no chart
  rerender(<Insights />);
  expect(screen.queryByTestId('insights-donut')).toBeNull();

  mockInsights = insightsData({ breakdown: {}, isLoading: true }); // first load → no chart
  rerender(<Insights />);
  expect(screen.queryByTestId('insights-donut')).toBeNull();

  mockInsights = insightsData({ breakdown: {}, isError: true }); // error → no chart
  rerender(<Insights />);
  expect(screen.queryByTestId('insights-donut')).toBeNull();
});

it('refreshes breakdown (query) AND AI on focus', () => {
  render(<Insights />);
  expect(refetchStale).toHaveBeenCalled();
  expect(refreshAiInsights).toHaveBeenCalled();
});

it('renders the hero total and pluralised category count', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 5 }, groceries: { posted: 80, pending: 0 } } }); // 25 + 80
  render(<Insights />);
  expect(screen.getByText('$105')).toBeTruthy();
  expect(screen.getByText(/across 2 categories/)).toBeTruthy();
});

it('uses the singular "category" for exactly one spent row', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 12, pending: 0 } } });
  render(<Insights />);
  expect(screen.getByText(/across 1 category$/)).toBeTruthy();
});

it('shows a spinner (not the empty state, not a false $0) while a first fetch is in flight', () => {
  mockInsights = insightsData({ breakdown: {}, isLoading: true });
  render(<Insights />);
  expect(screen.getByTestId('insights-loading')).toBeTruthy();
  expect(screen.queryByText('No spending yet this pay cycle.')).toBeNull();
  expect(screen.queryByText('$0')).toBeNull(); // hero must not show a confident $0
});

it('shows an inline error + Retry (not a false $0) on a sustained breakdown failure', () => {
  mockInsights = insightsData({ breakdown: {}, isError: true });
  render(<Insights />);
  expect(screen.getByTestId('insights-error')).toBeTruthy();
  fireEvent.press(screen.getByTestId('insights-retry'));
  expect(refetch).toHaveBeenCalled();
  expect(screen.queryByText('$0')).toBeNull();
});

it('keeps rows visible when a refresh is in flight (does not flash the spinner)', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 0 } }, isLoading: true });
  render(<Insights />);
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByTestId('insights-loading')).toBeNull();
});

// --- AI insights (WHIT-104) — unchanged behaviour, still on the context store ---

it('shows the idle prompt + the analyse button before any AI insight exists', () => {
  mockState = state({ aiInsights: null });
  render(<Insights />);
  expect(screen.getByText('Worth a look')).toBeTruthy();
  expect(screen.getByText('Analyse my spending')).toBeTruthy();
  expect(screen.getByText(/Sends your category spend totals to Anthropic/)).toBeTruthy();
});

it('tapping "Analyse my spending" calls generateAiInsights', () => {
  mockState = state({ aiInsights: null });
  render(<Insights />);
  fireEvent.press(screen.getByText('Analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalled();
});

it('keeps the note spend-only (no loan figures) when the loan goal is not ready', () => {
  mockState = state({ aiInsights: null });
  render(<Insights />);
  expect(screen.getByText(/Sends your category spend totals to Anthropic/)).toBeTruthy();
  expect(screen.queryByText(/home-loan figures/)).toBeNull();
});

it('names home-loan figures in the note + sends a goal once the loan is ready (WHIT-134)', () => {
  mockState = state({ aiInsights: null, loanFacts: READY_LOAN_FACTS, homeLoan: { balance: 528000, asOf: null } });
  render(<Insights />);
  expect(screen.getByText(/home-loan figures \(balance, rate, repayments\)/)).toBeTruthy();
  fireEvent.press(screen.getByText('Analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalledWith(expect.objectContaining({ payoff_mode: 'ahead', mortgage_free_date: expect.any(String) }));
});

it('the COMPACT refresh also forwards the goal with loan figures named', () => {
  mockState = state({
    aiInsights: { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    loanFacts: READY_LOAN_FACTS,
    homeLoan: { balance: 528000, asOf: null },
  });
  render(<Insights />);
  expect(screen.getByText(/Re-analysing sends your category spend totals and home-loan figures/)).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Re-analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalledWith(expect.objectContaining({ payoff_mode: 'ahead', mortgage_free_date: expect.any(String) }));
});

it('renders the AI summary + each suggestion once generated', () => {
  mockState = state({
    aiInsights: { summary: 'You are pacing well this cycle.', suggestions: ['Trim $20 from Coffee', 'Watch Groceries'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
  });
  render(<Insights />);
  expect(screen.getByText('You are pacing well this cycle.')).toBeTruthy();
  expect(screen.getByText('Trim $20 from Coffee')).toBeTruthy();
  expect(screen.getByText('Watch Groceries')).toBeTruthy();
  expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy();
  expect(screen.queryByText('Analyse my spending')).toBeNull();
  expect(screen.getByText(/Re-analysing sends your category spend totals to Anthropic/)).toBeTruthy();
});

it('tapping the compact refresh re-runs generation', () => {
  mockState = state({ aiInsights: { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false } });
  render(<Insights />);
  fireEvent.press(screen.getByLabelText('Re-analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalled();
});

it('shows a "generated ago" stamp from the timestamp', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  mockState = state({ aiInsights: { summary: 'ok', suggestions: [], generated_at: twoDaysAgo, cycle_start: '2026-06-25', cached: true } });
  render(<Insights />);
  expect(screen.getByText('2d ago')).toBeTruthy();
});

it('keeps the insight visible + swaps the refresh for a spinner while re-running', () => {
  mockState = state({
    aiInsights: { summary: 'still here', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    aiInsightsLoading: true,
  });
  render(<Insights />);
  expect(screen.getByText('still here')).toBeTruthy();
  expect(screen.getByTestId('ai-refresh-busy')).toBeTruthy();
  expect(screen.queryByLabelText('Re-analyse my spending')).toBeNull();
});

it('surfaces a failed re-analyse without dropping the existing advice', () => {
  mockState = state({
    aiInsights: { summary: 'keep me', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    aiInsightsError: true,
  });
  render(<Insights />);
  expect(screen.getByText('keep me')).toBeTruthy();
  expect(screen.getByText(/Couldn’t refresh/)).toBeTruthy();
  expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy();
});

it('shows a retryable error when generation failed', () => {
  mockState = state({ aiInsights: null, aiInsightsError: true });
  render(<Insights />);
  expect(screen.getByText(/Couldn’t generate insights/)).toBeTruthy();
  expect(screen.getByText('Try again')).toBeTruthy();
});

it('refreshes any cached AI insight when the tab gains focus', () => {
  render(<Insights />);
  expect(refreshAiInsights).toHaveBeenCalled();
});

// --- WHIT-142: screen-reader a11y for the AI re-analyse busy/result --------------
const AI = { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false };

describe('AI re-analyse a11y (WHIT-142)', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('gives the re-analyse busy spinner an accessible name (labelled control is unmounted)', () => {
    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    render(<Insights />);
    expect(screen.getByLabelText('Re-analysing your spending')).toBeTruthy();
    expect(screen.queryByLabelText('Re-analyse my spending')).toBeNull(); // the button is gone while busy
  });

  it('gives the first-run generate busy spinner an accessible name', () => {
    mockState = state({ aiInsights: null, aiInsightsLoading: true });
    render(<Insights />);
    expect(screen.getByLabelText('Analysing your spending')).toBeTruthy();
    expect(screen.getByTestId('ai-generate-busy')).toBeTruthy();
  });

  it('announces success on the loading → done edge', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    const { rerender } = render(<Insights />);
    expect(announce).not.toHaveBeenCalled(); // still analysing → nothing yet

    mockState = state({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    rerender(<Insights />);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith('Spending analysis ready.');
  });

  // WHIT-68: if the user switches to a PAST cycle mid-analysis, the coach card unmounts, so
  // the loading→done announce must NOT fire — otherwise a screen reader claims content is
  // "ready" for a card that's no longer on screen.
  it('does NOT announce when analysis finishes while viewing a past cycle (coach hidden)', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    const { rerender } = render(<Insights />);

    fireEvent.press(screen.getByTestId('insights-cycle-prev')); // move to Last cycle → coach hidden
    mockState = state({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    rerender(<Insights />);

    expect(announce).not.toHaveBeenCalled(); // withheld while the coach is off-screen
  });

  it('announces failure on the loading → done edge when the run errored', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    const { rerender } = render(<Insights />);

    mockState = state({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: true });
    rerender(<Insights />);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("Couldn't analyse your spending. Please try again.");
  });

  // The real regression this card guards: the announce must NOT fire except on a genuine
  // analyse/re-analyse completion — not on mount, not on a mid-load mount, not on tab focus.
  it('does NOT announce on a plain mount (never analysing)', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: false });
    render(<Insights />); // useFocusEffect fires refreshAiInsights on mount — must not announce
    expect(announce).not.toHaveBeenCalled();
  });

  it('does NOT announce when it mounts already loading (no transition witnessed)', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    render(<Insights />);
    expect(announce).not.toHaveBeenCalled();
  });

  it('does NOT announce on a focus re-render while loading stays constant', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: false });
    const { rerender } = render(<Insights />);
    rerender(<Insights />); // a re-render with no loading transition (e.g. focus refetch)
    expect(announce).not.toHaveBeenCalled();
  });
});

// Adversarial gap tests (qa): re-arming across runs, the first-run (no-insight) completion
// path, and a stronger at-rest negative that a "fire whenever !loading" bug would fail.
describe('AI re-analyse a11y — gap tests (WHIT-142)', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  // Re-arm: two full analyse cycles must announce twice. Guards the ref reset — drop it and
  // the ref never re-arms, so the 2nd completion never announces.
  it('announces once per completion across a true→false→true→false sequence', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    const { rerender } = render(<Insights />);

    mockState = state({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    rerender(<Insights />); // 1st completion → announce #1
    expect(announce).toHaveBeenCalledTimes(1);

    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    rerender(<Insights />); // re-analyse starts again → no announce, re-arm
    expect(announce).toHaveBeenCalledTimes(1);

    mockState = state({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    rerender(<Insights />); // 2nd completion → announce #2
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith('Spending analysis ready.');
  });

  // First-run path, NOT gated on hasAi: a first-run generate that FAILS leaves aiInsights null
  // (hasAi stays false), so a hasAi-gated announce would wrongly stay silent. It must still
  // speak the failure. Pins both the first-run failure announce and the no-hasAi-gate contract
  // (a first-run SUCCESS can't pin it — success populates aiInsights, making hasAi true anyway).
  it('announces failure when a FIRST-RUN generate fails (aiInsights stays null → not gated on hasAi)', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: null, aiInsightsLoading: true });
    const { rerender } = render(<Insights />);
    expect(screen.getByTestId('ai-generate-busy')).toBeTruthy(); // first-run busy element
    expect(announce).not.toHaveBeenCalled();

    mockState = state({ aiInsights: null, aiInsightsLoading: false, aiInsightsError: true });
    rerender(<Insights />);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("Couldn't analyse your spending. Please try again.");
  });

  // At-rest negative: announce once on a real edge, then a further at-rest re-render (e.g. a
  // focus refetch) must NOT re-announce. Guards post-completion quiescence — it catches a
  // "fire on every render while !loading" degradation (the kind that also drops dep-skipping);
  // an identical-deps re-render is otherwise skipped by React, which is itself the correct outcome.
  it('does NOT re-announce on an at-rest re-render after a completion', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    mockState = state({ aiInsights: AI, aiInsightsLoading: true });
    const { rerender } = render(<Insights />);

    mockState = state({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    rerender(<Insights />); // completion → announce once
    expect(announce).toHaveBeenCalledTimes(1);

    rerender(<Insights />); // same at-rest state → must stay at 1
    expect(announce).toHaveBeenCalledTimes(1);
  });
});
