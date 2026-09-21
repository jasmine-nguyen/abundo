// WHIT-68 — Insights "This cycle / Last cycle" toggle: adversarial GAPS (client PR 2/2).
// Independent of the implementer's insightsBreakdownQuery tests (which already lock the
// relabel, the cache-first toggle-BACK with no cycle-0 refetch, and the EMPTY-coach
// reappearance). This file adds only what those miss:
//   [A6] accessibilityState.selected tracks the active segment on BOTH segments (a11y lock)
//   [A7] a past-cycle read that FAILS shows the inline error + Retry, and Retry refetches
//        cycle 1 (the cycle-keyed error path, end to end)
//   [A8] a POPULATED coach (summary + suggestions) is hidden on the last cycle and its
//        content is restored on switch back (not just the "Worth a look" header)
// Same mock shape as insightsBreakdownQuery.screen.test.tsx: ../api + ../auth + expo-router
// mocked; ../context PARTIALLY mocked (real selectors, a MUTABLE useAppContext so a test can
// populate the AI coach).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFetchBreakdown = jest.fn<(days: number, cycle?: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number, number?])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

// Mutable AI slice so [A8] can populate the coach (summary + suggestions).
type Ai = { summary: string; suggestions: string[]; generated_at: string } | null;
let mockAi: Ai = null;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      aiInsights: mockAi,
      aiInsightsLoading: false,
      aiInsightsError: false,
      refreshAiInsights: jest.fn(),
      generateAiInsights: jest.fn(),
      loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
      homeLoan: { balance: null, asOf: null },
    }),
  };
});

jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Insights from '../../app/(tabs)/insights';

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

function makeClient(retry: boolean | number = false) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime: 60_000, gcTime: Infinity } } });
}
function renderInsights(client = makeClient()) {
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Insights)));
}

beforeEach(() => {
  mockAi = null;
  mockFetchBreakdown.mockReset().mockResolvedValue(BREAKDOWN);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
});

// [A6] a11y lock — VoiceOver reads the active segment. Asserts BOTH segments so a
// "both selected" / "hardcoded true" regression bites (the implementer's tests never
// read accessibilityState).
it('[A6] segmented control accessibilityState.selected tracks the active segment (both segments)', async () => {
  renderInsights();
  await screen.findByText('Cafes & Coffee');

  // on mount: current selected, prev NOT
  expect(screen.getByTestId('insights-cycle-current').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('insights-cycle-prev').props.accessibilityState.selected).toBe(false);

  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  await screen.findByText('LAST PAY CYCLE');

  // after tapping "Last cycle": selection flips — prev selected, current NOT
  expect(screen.getByTestId('insights-cycle-prev').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('insights-cycle-current').props.accessibilityState.selected).toBe(false);
});

// [A7] the cycle-keyed error path end to end: cycle 0 loads fine, switching to a past
// cycle whose read FAILS must show the inline error + Retry (not a stale cycle-0 hero or
// a confident $0), and Retry must refetch cycle 1 specifically.
it('[A7] a past-cycle read that FAILS shows inline error + Retry; Retry refetches cycle 1', async () => {
  mockFetchBreakdown.mockReset().mockImplementation((_d: number, cycle = 0) =>
    cycle === 1 ? Promise.reject(new Error('API error: 503')) : Promise.resolve(BREAKDOWN));
  renderInsights(makeClient(false));
  await screen.findByText('Cafes & Coffee');

  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  expect(await screen.findByTestId('insights-error')).toBeTruthy();
  expect(screen.queryByText('$0')).toBeNull();               // no confident zero over a past-cycle error
  expect(screen.queryByText('Cafes & Coffee')).toBeNull();   // no stale cycle-0 rows bleeding through

  // Retry — cycle 1 now succeeds with its own data.
  mockFetchBreakdown.mockReset().mockImplementation((_d: number, cycle = 0) =>
    Promise.resolve(cycle === 1 ? { coffee: { posted: 5, pending: 0 } } : BREAKDOWN));
  fireEvent.press(screen.getByTestId('insights-retry'));

  await screen.findByText('Cafes & Coffee');
  expect(screen.getByText('LAST PAY CYCLE')).toBeTruthy();    // still on the past cycle after recovery
  expect(mockFetchBreakdown).toHaveBeenCalledWith(expect.any(Number), 1); // the refetch was for cycle 1
});

// [A8] a POPULATED coach must vanish ENTIRELY on the past cycle (summary + suggestion
// tips, not merely the header the implementer checks) and come back intact on switch
// back — proves it's a conditional render, not a permanent unmount or a header-only hide.
it('[A8] a populated AI coach (summary + tips) is hidden on last cycle and restored on switch back', async () => {
  mockAi = {
    summary: 'You spent a lot on coffee this cycle.',
    suggestions: ['Brew at home twice a week', 'Skip the afternoon latte'],
    generated_at: '2026-07-08T00:00:00Z',
  };
  renderInsights();
  await screen.findByText('Cafes & Coffee');

  // current cycle: the populated coach content is on screen
  expect(screen.getByText('You spent a lot on coffee this cycle.')).toBeTruthy();
  expect(screen.getByText('Brew at home twice a week')).toBeTruthy();
  expect(screen.getByText('Skip the afternoon latte')).toBeTruthy();

  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  await screen.findByText('LAST PAY CYCLE');

  // past cycle: the WHOLE coach is gone, content included
  expect(screen.queryByText('Worth a look')).toBeNull();
  expect(screen.queryByText('You spent a lot on coffee this cycle.')).toBeNull();
  expect(screen.queryByText('Brew at home twice a week')).toBeNull();
  expect(screen.queryByText('Skip the afternoon latte')).toBeNull();

  fireEvent.press(screen.getByTestId('insights-cycle-current'));
  await screen.findByText('THIS PAY CYCLE');

  // back to current: the coach + its content are restored
  expect(screen.getByText('You spent a lot on coffee this cycle.')).toBeTruthy();
  expect(screen.getByText('Brew at home twice a week')).toBeTruthy();
  expect(screen.getByText('Skip the afternoon latte')).toBeTruthy();
});
