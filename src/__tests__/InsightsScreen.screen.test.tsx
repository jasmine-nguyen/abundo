// Screen test: the Insights tab (WHIT-23). Verifies rows render from the breakdown
// (with the pending portion visible), the Uncategorized row shows, the empty state
// appears, and focusing the tab refreshes. Context is injected via jest.mock, and
// the real categoryBreakdown selector runs over the mocked state.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { UNCATEGORIZED_KEY } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

// Insights reads useFocusEffect from expo-router (a native module). Run the callback
// through a real effect so the refresh-on-focus behaviour is exercised.
jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]) };
});

import Insights from '../../app/(tabs)/insights';

const refreshBreakdown = jest.fn();
const refreshAiInsights = jest.fn();
const generateAiInsights = jest.fn();

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7FD49B', bucket: 'Living', recent: 0 },
] as const;

function state(over: Partial<AppContext>): AppContext {
  return {
    breakdown: {},
    breakdownLoading: false,
    refreshBreakdown,
    aiInsights: null,
    aiInsightsLoading: false,
    aiInsightsError: false,
    refreshAiInsights,
    generateAiInsights,
    category: (id: string | null) => CATS.find((c) => c.id === id),
    ...over,
  } as unknown as AppContext;
}

beforeEach(() => {
  refreshBreakdown.mockClear();
  refreshAiInsights.mockClear();
  generateAiInsights.mockClear();
});

it('renders a row per spent category with the pending portion visible', () => {
  mockState = state({
    breakdown: {
      coffee: { posted: 20, pending: 5 },
      groceries: { posted: 80, pending: 0 },
    },
  });
  render(<Insights />);
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Groceries')).toBeTruthy();
  // coffee has pending -> its sub-label calls it out ("$25 · $5 pending"). Anchor on
  // the "$… pending" amount so it can't collide with the "Analyse my spending" button.
  expect(screen.getByText(/\$5 pending/)).toBeTruthy();
});

it('shows the Uncategorized bucket as a row', () => {
  mockState = state({
    breakdown: {
      coffee: { posted: 40, pending: 0 },
      [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 },
    },
  });
  render(<Insights />);
  expect(screen.getByText('Uncategorized')).toBeTruthy();
});

it('shows an empty state when there is no spend', () => {
  mockState = state({ breakdown: {} });
  render(<Insights />);
  expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
});

it('refreshes the breakdown when the tab gains focus', () => {
  mockState = state({ breakdown: {} });
  render(<Insights />);
  expect(refreshBreakdown).toHaveBeenCalled();
});

it('renders the hero total and pluralised category count', () => {
  mockState = state({
    breakdown: {
      coffee: { posted: 20, pending: 5 },    // 25
      groceries: { posted: 80, pending: 0 }, // 80  -> total 105
    },
  });
  render(<Insights />);
  expect(screen.getByText('$105')).toBeTruthy();
  expect(screen.getByText(/across 2 categories/)).toBeTruthy();
});

it('uses the singular "category" for exactly one spent row', () => {
  mockState = state({ breakdown: { coffee: { posted: 12, pending: 0 } } });
  render(<Insights />);
  expect(screen.getByText(/across 1 category$/)).toBeTruthy();
});

it('shows Loading not the empty state while a first fetch is in flight', () => {
  // loading = breakdownLoading && rows.length === 0 -> must NOT lie "no spending".
  mockState = state({ breakdown: {}, breakdownLoading: true });
  render(<Insights />);
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.queryByText('No spending yet this pay cycle.')).toBeNull();
});

it('keeps rows visible when a refresh is in flight (does not flash Loading)', () => {
  mockState = state({
    breakdown: { coffee: { posted: 20, pending: 0 } },
    breakdownLoading: true,
  });
  render(<Insights />);
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByText('Loading…')).toBeNull();
});

// --- AI insights (WHIT-104) --------------------------------------------------

it('shows the idle prompt + the analyse button before any AI insight exists', () => {
  mockState = state({ breakdown: {}, aiInsights: null });
  render(<Insights />);
  expect(screen.getByText('Wren’s take')).toBeTruthy();
  expect(screen.getByText('Analyse my spending')).toBeTruthy();
  // The full privacy note is present before the first send so it's a conscious choice.
  expect(screen.getByText(/Sends your category spend totals to Anthropic/)).toBeTruthy();
});

it('tapping "Analyse my spending" calls generateAiInsights', () => {
  mockState = state({ breakdown: {}, aiInsights: null });
  render(<Insights />);
  fireEvent.press(screen.getByText('Analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalled();
});

it('renders the AI summary + each suggestion once generated', () => {
  mockState = state({
    breakdown: {},
    aiInsights: {
      summary: 'You are pacing well this cycle.',
      suggestions: ['Trim $20 from Coffee', 'Watch Groceries'],
      generated_at: 't', cycle_start: '2026-06-25', cached: false,
    },
  });
  render(<Insights />);
  expect(screen.getByText('You are pacing well this cycle.')).toBeTruthy();
  expect(screen.getByText('Trim $20 from Coffee')).toBeTruthy();
  expect(screen.getByText('Watch Groceries')).toBeTruthy();
  // With an insight present the re-run is a compact refresh control (not a big button)
  // and the disclosure is the shorter form (Anthropic still named).
  expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy();
  expect(screen.queryByText('Analyse my spending')).toBeNull();
  expect(screen.getByText(/sent to Anthropic/)).toBeTruthy();
});

it('tapping the compact refresh re-runs generation', () => {
  mockState = state({
    breakdown: {},
    aiInsights: { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
  });
  render(<Insights />);
  fireEvent.press(screen.getByLabelText('Re-analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalled();
});

it('shows a "generated ago" stamp from the timestamp', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  mockState = state({
    breakdown: {},
    aiInsights: { summary: 'ok', suggestions: [], generated_at: twoDaysAgo, cycle_start: '2026-06-25', cached: true },
  });
  render(<Insights />);
  expect(screen.getByText('2d ago')).toBeTruthy();
});

it('keeps the insight visible + swaps the refresh for a spinner while re-running', () => {
  mockState = state({
    breakdown: {},
    aiInsights: { summary: 'still here', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    aiInsightsLoading: true,
  });
  render(<Insights />);
  // The old advice stays put (no flash to empty)...
  expect(screen.getByText('still here')).toBeTruthy();
  // ...and the tappable refresh is replaced by the busy spinner (positive assertion so
  // this fails if the swap regresses).
  expect(screen.getByTestId('ai-refresh-busy')).toBeTruthy();
  expect(screen.queryByLabelText('Re-analyse my spending')).toBeNull();
});

it('surfaces a failed re-analyse without dropping the existing advice', () => {
  // hasAi stays true on a re-run failure -> the error must still be shown (a silent
  // stop would leave stale advice with no signal). The refresh stays tappable to retry.
  mockState = state({
    breakdown: {},
    aiInsights: { summary: 'keep me', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    aiInsightsError: true,
  });
  render(<Insights />);
  expect(screen.getByText('keep me')).toBeTruthy();          // advice retained
  expect(screen.getByText(/Couldn’t refresh/)).toBeTruthy(); // failure is announced
  expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy(); // retry available
});

it('shows a retryable error when generation failed', () => {
  mockState = state({ breakdown: {}, aiInsights: null, aiInsightsError: true });
  render(<Insights />);
  expect(screen.getByText(/Couldn’t generate insights/)).toBeTruthy();
  // On the error path the first-run button becomes an explicit retry.
  expect(screen.getByText('Try again')).toBeTruthy();
});

it('refreshes any cached AI insight when the tab gains focus', () => {
  mockState = state({ breakdown: {} });
  render(<Insights />);
  expect(refreshAiInsights).toHaveBeenCalled();
});
