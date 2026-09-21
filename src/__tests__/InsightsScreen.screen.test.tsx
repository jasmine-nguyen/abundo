// Screen test: the Insights tab. Breakdown (spend-by-category) now comes from the
// query layer (WHIT-189) — the `useInsightsScreenData` composite is mocked here to feed
// controlled breakdown/state; the AI-insights feature still reads the context store
// (`useAppContext`), mocked as before. The real `categoryBreakdown` selector runs over
// the mocked breakdown. Real query behaviour (fetch/self-heal/auth-gate) is covered by
// insightsBreakdownQuery.screen.test.tsx.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { render, screen, fireEvent, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import type { AppContext, LoanFacts } from '../context';
import { UNCATEGORIZED_KEY } from '../context';
import { C } from '../theme';
import { CATEGORY_COLORS } from '../chartColors';

// WHIT-192: insights.tsx reads only the AI slice off the store; loanFacts/homeLoan come
// from useGoalScreenData (query layer). The fixture carries the AI slice PLUS loanFacts/
// homeLoan purely to feed the mocked useGoalScreenData below — they're no longer on the store.
type InsightsState = Pick<AppContext, 'aiInsights' | 'aiInsightsLoading' | 'aiInsightsError' | 'refreshAiInsights' | 'generateAiInsights'>
  & { loanFacts: LoanFacts; homeLoan: { balance: number | null; asOf: string | null } };

// Breakdown data — the query composite. Typed `unknown` because the WHIT-451-merged suites below
// each feed their own differently-shaped insightsData(); consumers are typed by the real ../queries.
let mockInsights: unknown;
jest.mock('../queries', () => ({ useInsightsScreenData: () => mockInsights, useGoalScreenData: () => ({ loanFacts: mockState.loanFacts, homeLoan: mockState.homeLoan, repayment: { amount: null, date: null, principal: null, interest: null }, isLoading: false, isError: false, homeLoanError: false, refetch: jest.fn(), refetchStale: jest.fn() }) }));

// AI state — the context store.
let mockState: InsightsState;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

// Run the focus callback through a real effect so refresh-on-focus is exercised. `mockPush` is the
// router.push spy the category-row drills call (asserted in the drill-destination tests below).
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]), useRouter: () => ({ push: mockPush }) };
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
function insightsData(over: Partial<{ breakdown: Record<string, { posted: number; pending: number }>; earned: number; incomeSources: { id: string; posted: number; pending: number; amount: number }[]; isLoading: boolean; isError: boolean }>) {
  return { breakdown: {}, earned: 0, incomeSources: [], category, isLoading: false, isError: false, refetch, refetchStale, ...over };
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

it('draws the earned-vs-spent chart when there is spend, on BOTH cycle tabs', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 5 }, groceries: { posted: 80, pending: 0 } }, earned: 3000 });
  render(<Insights />);
  expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
  // Unlike the AI coach card (current-cycle only), it stays on "Last cycle" too.
  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
});

it('shows the earned-vs-spent chart on an income-only cycle (income, no spend rows)', () => {
  mockInsights = insightsData({ breakdown: {}, earned: 3000 }); // earned but nothing spent
  render(<Insights />);
  expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
});

it('never draws the earned-vs-spent chart over an empty/loading/error state', () => {
  mockInsights = insightsData({ breakdown: {}, earned: 0 }); // no income, no spend
  const { rerender } = render(<Insights />);
  expect(screen.queryByTestId('insights-earned-spent')).toBeNull();

  mockInsights = insightsData({ breakdown: {}, earned: 3000, isLoading: true }); // first load
  rerender(<Insights />);
  expect(screen.queryByTestId('insights-earned-spent')).toBeNull();

  // A sustained error with nothing cached (rows empty) → showError suppresses the chart
  // even though earned is set.
  mockInsights = insightsData({ breakdown: {}, earned: 3000, isError: true });
  rerender(<Insights />);
  expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
});

it('refreshes breakdown (query) AND AI on focus', () => {
  render(<Insights />);
  expect(refetchStale).toHaveBeenCalled();
  expect(refreshAiInsights).toHaveBeenCalled();
});

it('renders the hero total and pluralised category count', () => {
  mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 5 }, groceries: { posted: 80, pending: 0 } } }); // 25 + 80
  render(<Insights />);
  // The donut centre also reads the total now, so target the hero by testID to disambiguate.
  expect(screen.getByTestId('insights-hero-total').props.children).toBe('$105');
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

// WHIT-312 (qa gaps) — the earned-vs-spent chart's interaction with the screen's other states.
describe('earned-vs-spent chart — screen gaps (WHIT-312)', () => {
  // [A9] income-only cycle: the chart shows AND the "No spending yet" empty text still shows
  // (rows.length===0). Pins the CURRENT double-message behaviour so a future change to either
  // gate is a conscious decision, not a silent regression. (Flagged in the critique.)
  it('an income-only cycle shows BOTH the chart and the no-spending empty text', () => {
    mockInsights = insightsData({ breakdown: {}, earned: 3000 });
    render(<Insights />);
    expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
    expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
    // Nothing spent means the whole income is surplus, so the pairing reads coherently.
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$3,000 surplus');
  });

  // [A10] the chart's spent bar reads the SAME total as the hero — both come off categoryBreakdown,
  // so they can't diverge. 20 + 5 + 80 = 105. Guards against the chart being fed a different spend.
  it('feeds the chart the same spend total as the hero', () => {
    mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 5 }, groceries: { posted: 80, pending: 0 } }, earned: 3000 });
    render(<Insights />);
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$105');
    // The surplus is earned − spent = 3000 − 105: it can only read $2,895 if the chart was
    // fed the SAME $105 spend total the hero shows. A different spend would change this string.
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$2,895 surplus');
  });
});

// WHIT-373 — the Earned/Spent card is a pure summary now: no per-bar drill chevron, no press
// targets. The Spending/Earning toggle below is the one way to drill in (see insightsSideToggle).
describe('Earned/Spent card is summary-only (WHIT-373)', () => {
  it('renders no drill press targets on either bar', () => {
    mockInsights = insightsData({
      breakdown: { coffee: { posted: 40, pending: 0 } },
      earned: 3000,
      incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
    });
    render(<Insights />);
    expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();  // card still shows
    expect(screen.queryByTestId('earned-bar-press')).toBeNull();       // no Earned drill
    expect(screen.queryByTestId('spent-bar-press')).toBeNull();        // no Spent drill
    // FAIL-ON-REVERT: restoring the onSpentPress wiring makes spent-bar-press render again.
  });
});

describe('Insights refund line (WHIT-349)', () => {
  const CATS = [
    { id: 'car', name: 'Car', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: null, recent: 0 },
    { id: 'petrol', name: 'Petrol', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
    { id: 'tolls', name: 'Tolls', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
  ] as const;
  const category = (id: string) => CATS.find((c) => c.id === id) as never;
  
  // petrol 60, tolls net -30 (floored to 0), car node netted to 30 + a tolls refund line.
  function insightsData(over: Partial<{ breakdown: Record<string, unknown>; isLoading: boolean; isError: boolean }> = {}) {
    const breakdown: Record<string, unknown> = {
      petrol: { posted: 60, pending: 0 },
      tolls: { posted: 0, pending: 0 },
      __rollup__: { nodes: { car: { posted: 30, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
    };
    return { breakdown, earned: 0, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over } as { breakdown: Record<string, unknown>; earned: number; category: typeof category; isLoading: boolean; isError: boolean; refetch: () => void; refetchStale: () => void };
  }
  
  beforeEach(() => {
    mockPush.mockClear();
    mockInsights = insightsData();
    mockState = {
      aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
      refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
      generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
      loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null } as LoanFacts,
      homeLoan: { balance: null, asOf: null },
    };
  });
  
  it('shows the netted parent, then a tappable refund line when expanded', () => {
    render(<Insights />);
    // The Car parent renders (its netted $30 total is locked in the logic test).
    expect(screen.getByText('Car')).toBeTruthy();
    // Collapsed: the refund line isn't shown yet.
    expect(screen.queryByText(/refund/)).toBeNull();
  
    // Expand Car -> the refund line appears, reconciling petrol 60 - 30 = 30.
    fireEvent.press(screen.getByText('Car'));
    expect(screen.getByText('Petrol')).toBeTruthy();
    expect(screen.getByText('Tolls')).toBeTruthy();
    expect(screen.getByText(/refund/)).toBeTruthy();
  
    // A tap on the refund line drills into the refunded sub's transactions.
    fireEvent.press(screen.getByText('Tolls'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/category/tolls'));
  });
});

describe('Insights refund line gaps (WHIT-349)', () => {
  const CATS = [
    { id: 'car', name: 'Car', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: null, recent: 0 },
    { id: 'petrol', name: 'Petrol', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
    { id: 'tolls', name: 'Tolls', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
  ] as const;
  const category = (id: string) => CATS.find((c) => c.id === id) as never;
  
  // petrol 60, tolls net -30 (floored), car netted to 30 + a tolls refund line of -30.
  function insightsData(over: Partial<{ breakdown: Record<string, unknown> }> = {}) {
    const breakdown: Record<string, unknown> = {
      petrol: { posted: 60, pending: 0 },
      tolls: { posted: 0, pending: 0 },
      __rollup__: { nodes: { car: { posted: 30, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
    };
    return { breakdown, earned: 0, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over } as { breakdown: Record<string, unknown>; earned: number; category: typeof category; isLoading: boolean; isError: boolean; refetch: () => void; refetchStale: () => void };
  }
  
  beforeEach(() => {
    mockPush.mockClear();
    mockInsights = insightsData();
    mockState = {
      aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
      refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
      generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
      loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null } as LoanFacts,
      homeLoan: { balance: null, asOf: null },
    };
  });
  
  it('the hero shows the NETTED parent total (30), never the floored-leaf sum (60)', () => {
    render(<Insights />);
    // The hero total reads the netted cycle spend: car node 30, NOT petrol's floored 60.
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$30');
  });
  
  it('the refund is not counted as a category: "spent across 1 category"', () => {
    render(<Insights />);
    // One top-level category (Car). The refund line is NEVER a top-level row / donut wedge, so
    // the count stays 1 even though a Tolls refund line exists under Car.
    expect(screen.getByText('spent across 1 category')).toBeTruthy();
  });
  
  it('expanding does not change the hero total (refund is display-only)', () => {
    render(<Insights />);
    fireEvent.press(screen.getByText('Car'));
    // The refund line now renders, but the hero total is unchanged — it is excluded from the total.
    expect(screen.getByText(/refund/)).toBeTruthy();
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$30');
  });
});

describe('Insights remainder/Other plug (WHIT-357/375)', () => {
  const CATS = [
    { id: 'car', name: 'Car', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: null, recent: 0 },
    { id: 'petrol', name: 'Petrol', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
    { id: 'tolls', name: 'Tolls', icon: 'car', color: '#8AB4F8', bucket: 'Living', parent: 'car', recent: 0 },
  ] as const;
  const category = (id: string) => CATS.find((c) => c.id === id) as never;
  
  // petrol 100, tolls net -30 (floored to 0 -> refund line), car node 130. The visible children sum to
  // 100 + (-30) = 70, under-summing the node (130) -> WHIT-357 plugs a +60 "Other" line under car.
  // $60 appears nowhere else on screen (100 / 130 / 30 are the other amounts), so it uniquely marks the plug.
  function insightsData(over: Partial<{ breakdown: Record<string, unknown>; isLoading: boolean; isError: boolean }> = {}) {
    const breakdown: Record<string, unknown> = {
      petrol: { posted: 100, pending: 0 },
      tolls: { posted: 0, pending: 0 },
      __rollup__: { nodes: { car: { posted: 130, pending: 0 } }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
    };
    return { breakdown, earned: 0, category, isLoading: false, isError: false, refetch: jest.fn(), refetchStale: jest.fn(), ...over } as { breakdown: Record<string, unknown>; earned: number; category: typeof category; isLoading: boolean; isError: boolean; refetch: () => void; refetchStale: () => void };
  }
  
  // Climb to the enclosing row card (styles.row is the only node with borderRadius 20).
  function rowCard(node: ReactTestInstance): ReactTestInstance {
    let n: ReactTestInstance | null = node;
    while (n) {
      const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { borderRadius?: number } | undefined;
      if (st && st.borderRadius === 20) return n;
      n = n.parent;
    }
    throw new Error('no enclosing row card');
  }
  // A category-bar track (styles.track: height 8) — present on a real spend row, absent on a plug/refund.
  const tracksIn = (card: ReactTestInstance) => card.findAll((n) => {
    const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { height?: number } | undefined;
    return !!st && st.height === 8;
  });
  // The bold amount Text (styles.rowAmount: fontWeight '700') inside a card.
  const amountColor = (card: ReactTestInstance) => {
    const amt = card.findAll((n) => {
      const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { fontWeight?: string } | undefined;
      return !!st && st.fontWeight === '700';
    })[0];
    return (StyleSheet.flatten((amt.props as { style?: unknown }).style) as { color?: string }).color;
  };
  
  // The row NAME Text (styles.rowName: fontWeight '600') inside a card — its colour moved from a
  // hardcoded C.textDim to breakdownLineStyle's nameColor in WHIT-375, so lock it here.
  const nameColor = (card: ReactTestInstance) => {
    const nm = card.findAll((n) => {
      const st = StyleSheet.flatten((n.props as { style?: unknown }).style) as { fontWeight?: string } | undefined;
      return !!st && st.fontWeight === '600';
    })[0];
    return (StyleSheet.flatten((nm.props as { style?: unknown }).style) as { color?: string }).color;
  };
  
  beforeEach(() => {
    mockPush.mockClear();
    mockInsights = insightsData();
    mockState = {
      aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
      refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
      generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
      loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null } as LoanFacts,
      homeLoan: { balance: null, asOf: null },
    };
  });
  
  it('hides the "Other" plug until the parent is expanded, then shows it muted, un-barred, and un-tappable', () => {
    render(<Insights />);
    // Collapsed: the plug is not shown.
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull();
  
    // Expand Car -> children + the refund line + the adjustment plug appear.
    fireEvent.press(screen.getByText('Car'));
    expect(screen.getByText('Petrol')).toBeTruthy();
    const other = screen.getByText('Pending/refund adjustment');
    expect(other).toBeTruthy();
  
    const card = rowCard(other);
    // (a) neutral-coloured amount — textDim, NOT the refund green (C.good).
    expect(amountColor(card)).toBe(C.textDim);
    expect(amountColor(card)).not.toBe(C.good);
    // (b) NO bar/track under the plug row.
    expect(tracksIn(card)).toHaveLength(0);
    // (c) NOT tappable — no button in the row, and pressing it drills nowhere.
    expect(within(card).queryByRole('button')).toBeNull();
    fireEvent.press(other);
    expect(mockPush).not.toHaveBeenCalled();
  });
  
  it('the refund line under the SAME parent stays green + tappable — proving the plug checks are meaningful', () => {
    render(<Insights />);
    fireEvent.press(screen.getByText('Car'));
  
    // Positive control 1: the refund line ('Tolls') is green and IS a drill target.
    const refundCard = rowCard(screen.getByText('Tolls'));
    expect(amountColor(refundCard)).toBe(C.good);
    expect(within(refundCard).queryByRole('button')).toBeTruthy();
    fireEvent.press(screen.getByText('Tolls'));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/category/tolls'));
  
    // Positive control 2: a real spend row (Petrol) DOES carry a bar/track — so the plug's
    // "no track" assertion above is a real difference, not a query that never finds tracks.
    expect(tracksIn(rowCard(screen.getByText('Petrol')))).not.toHaveLength(0);
  });
  
  // WHIT-375 — [A1] gap symmetric to the breakdown refund test. insightsRemainderLine only locked
  // the refund COLOUR (green) + tappability, never that its AMOUNT is UNSIGNED. The refund's spent is
  // -30; the shared breakdownLineStyle must drop the sign so the line reads "$30", never "-$30" (the
  // historical drift the card guards). Fail-on-revert: sign the helper's amount and this flips to "-$30".
  it('renders the refund line amount UNSIGNED ("$30", never "-$30")', () => {
    render(<Insights />);
    fireEvent.press(screen.getByText('Car'));
  
    const refundCard = rowCard(screen.getByText('Tolls'));
    expect(within(refundCard).getByText('$30')).toBeTruthy();   // unsigned credit
    expect(within(refundCard).queryByText('-$30')).toBeNull();  // never the signed drift
  });
  
  // WHIT-375 — [A2] the refund/remainder NAME colour moved from a hardcoded C.textDim to the helper's
  // nameColor. Prove it's unchanged on BOTH kinds of line: dimmed (C.textDim), NOT the bright category
  // ink (C.textBright). Fail-on-revert: if the helper returned textBright for a refund/remainder name,
  // these flip.
  it('keeps the refund AND remainder NAME dimmed (C.textDim, not the bright ink)', () => {
    render(<Insights />);
    fireEvent.press(screen.getByText('Car'));
  
    const refundName = nameColor(rowCard(screen.getByText('Tolls')));
    expect(refundName).toBe(C.textDim);
    expect(refundName).not.toBe(C.textBright);
  
    const plugName = nameColor(rowCard(screen.getByText('Pending/refund adjustment')));
    expect(plugName).toBe(C.textDim);
    expect(plugName).not.toBe(C.textBright);
  
    // Control: a real spend row (Petrol) keeps the BRIGHT name — so "dimmed" is a real difference,
    // not a colour every row happens to share.
    expect(nameColor(rowCard(screen.getByText('Petrol')))).toBe(C.textBright);
  });
  
  it('a NEGATIVE "Other" plug renders its minus sign (WHIT-357 R1) so the rows visibly still add up', () => {
    // Trigger-2 shape: car own spend 100, but its node is 60 (a dropped net-negative sub ate 40).
    // The plug is -40. `fmt` strips the sign, so without the R1 fix this renders "$40" and the rows
    // read as 100 + 40 = 140 under a $60 parent. Assert the minus is shown.
    mockInsights = insightsData({
      breakdown: {
        car: { posted: 100, pending: 0 },       // car's OWN directly-tagged spend -> "Directly in Car" 100
        petrol: { posted: 0, pending: 0 },       // a sub that floored away (keeps car a parent)
        __rollup__: { nodes: { car: { posted: 60, pending: 0 } } },   // node 60 < own 100 -> -40 plug
      },
    });
    render(<Insights />);
    fireEvent.press(screen.getByText('Car'));
  
    const other = screen.getByText('Pending/refund adjustment');
    const card = rowCard(other);
    // The amount shows the sign: "-$40", not a bare "$40".
    expect(within(card).getByText('-$40')).toBeTruthy();
    expect(within(card).queryByText('$40')).toBeNull();   // no unsigned amount that would mislead
  });
});

describe('Insights spending/earning toggle (WHIT-373)', () => {
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
});

describe('Insights earning share bars (WHIT-373)', () => {
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
      aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
      refreshAiInsights: jest.fn() as AppContext['refreshAiInsights'],
      generateAiInsights: jest.fn() as AppContext['generateAiInsights'],
      loanFacts: NO_LOAN_FACTS, homeLoan: { balance: null, asOf: null },
    };
  }
  
  // The income share bars are inline Views filled with the SOURCE's chart-palette colour (WHIT chart
  // palette — each source its own colour, matching the pie, not a flat green). They're the only nodes
  // whose raw backgroundColor is a CATEGORY_COLORS hex: chips are rgba(tint) and the EarnedVsSpent card
  // bars are C.good/C.bad (not in the ramp), so neither matches. Collect each matching fill's width.
  const RAMP = new Set<string>(CATEGORY_COLORS);
  function incomeBarWidths(node: unknown, acc: string[] = []): string[] {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) { node.forEach((n) => incomeBarWidths(n, acc)); return acc; }
    const n = node as { props?: { style?: unknown; testID?: string }; children?: unknown[] };
    const style = n.props?.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : (style || {});
    if (RAMP.has((flat as { backgroundColor?: string }).backgroundColor as string)) {
      acc.push(String((flat as { width?: unknown }).width));
    }
    if (Array.isArray(n.children)) n.children.forEach((c) => incomeBarWidths(c, acc));
    return acc;
  }
  
  beforeEach(() => {
    mockPush.mockClear();
    mockState = state();
    mockInsights = insightsData({});
  });
  
  describe('Insights "Earning" share bars (WHIT-373)', () => {
    // [B1] Two positive sources → two green bars sized by share of shown income (3000 vs 500 of 3500).
    // The bigger source's bar must be wider. FAIL-ON-REVERT: if barPct divided by `earned` (or dropped
    // the incomeShareTotal denominator) the widths change; if the guard let the plug/reversed rows bar,
    // the count changes.
    it('[B1] draws a proportional green bar per positive source, biggest widest', () => {
      mockInsights = insightsData({
        breakdown: { coffee: { posted: 20, pending: 0 } },
        earned: 3500,
        incomeSources: [
          { id: 'salary', posted: 3000, pending: 0, amount: 3000 },
          { id: 'dividends', posted: 500, pending: 0, amount: 500 },
        ],
      });
      render(<Insights />);
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      const widths = incomeBarWidths(screen.toJSON());
      expect(widths).toHaveLength(2);
      // salary 3000/3500 ≈ 85.7% ; dividends 500/3500 ≈ 14.3%
      expect(parseFloat(widths[0])).toBeCloseTo((3000 / 3500) * 100, 5);
      expect(parseFloat(widths[1])).toBeCloseTo((500 / 3500) * 100, 5);
      expect(parseFloat(widths[0])).toBeGreaterThan(parseFloat(widths[1]));
    });
  
    // [B2] The muted reconcile plug is not a real source: it must render its label, get NO green bar,
    // and NOT be tappable. earned 3120 vs one 3000 source ⇒ a 120 plug. FAIL-ON-REVERT: wrapping the
    // muted row in a Pressable (drill) makes the press fire mockPush; letting the plug bar makes the
    // width count 2.
    it('[B2] the muted reconcile plug gets no bar and does not drill', () => {
      mockInsights = insightsData({
        breakdown: { coffee: { posted: 40, pending: 0 } },
        earned: 3120,
        incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
      });
      render(<Insights />);
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('Pending/refund adjustment')).toBeTruthy();
      // only the real source (salary) gets a green bar — the plug does not
      expect(incomeBarWidths(screen.toJSON())).toHaveLength(1);
      // tapping the plug row navigates nowhere (it has no Pressable wrapper)
      fireEvent.press(screen.getByText('Pending/refund adjustment'));
      expect(mockPush).not.toHaveBeenCalled();
      // the real source still drills
      fireEvent.press(screen.getByText('Salary'));
      expect(mockPush).toHaveBeenCalledWith('/category/salary?cycle=0');
    });
  
    // [B3] Every source clawed back this cycle → the positive denominator is 0. Rows still render (as
    // −$X), but NO bar may be drawn — no div-by-zero, no NaN width. earned = shownAmount so no plug.
    // NOTE: double-guarded (the `incomeShareTotal > 0` denominator AND the per-row `r.amount > 0` gate),
    // so no single revert reddens this — it's a defensive regression guard, not a fail-on-revert test.
    it('[B3] an all-reversed cycle renders rows but zero bars (denominator 0 is safe)', () => {
      mockInsights = insightsData({
        breakdown: {},
        earned: -300,
        incomeSources: [
          { id: 'salary', posted: -200, pending: 0, amount: -200 },
          { id: 'dividends', posted: -100, pending: 0, amount: -100 },
        ],
      });
      render(<Insights />);
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('-$200')).toBeTruthy();
      expect(screen.getByText('-$100')).toBeTruthy();
      expect(incomeBarWidths(screen.toJSON())).toHaveLength(0); // no green bars at all
    });
  
    // [B4] Stale-side carry: a user on Earning who moves to a spend-only cycle keeps the toggle (spend
    // has content) and lands on an honest "No income" empty — never a blank, never a category row on
    // the Earning side. Documents the clamp's real behaviour (side = sideChoice while the toggle shows).
    it('[B4] Earning choice carried into a later spend-only cycle shows the income empty, toggle intact', () => {
      mockInsights = insightsData({
        breakdown: { coffee: { posted: 20, pending: 0 } },
        earned: 3500,
        incomeSources: [{ id: 'salary', posted: 3000, pending: 0, amount: 3000 }],
      });
      const { rerender } = render(<Insights />);
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('Salary')).toBeTruthy();
      // same screen, new cycle's data arrives: spend only, no income sources
      mockInsights = insightsData({ breakdown: { coffee: { posted: 20, pending: 0 } }, earned: 0, incomeSources: [] });
      rerender(<Insights />);
      expect(screen.getByTestId('insights-side-earning')).toBeTruthy();        // toggle stays (spend present)
      expect(screen.getByText('No income yet this pay cycle.')).toBeTruthy();   // honest empty, not a spend row
      expect(screen.queryByText('Cafes & Coffee')).toBeNull();                 // still on Earning, spend hidden
      expect(incomeBarWidths(screen.toJSON())).toHaveLength(0);
    });
  });
});
