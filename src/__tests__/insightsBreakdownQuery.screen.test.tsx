// WHIT-189 — the Insights breakdown on the real query layer. Proves the migration's
// behaviours: breakdown comes from the auth-gated query (not fetched before login),
// windows on the real cycle length, a transient 5xx self-heals, a sustained failure
// shows an inline Retry — and crucially the breakdown failure is scoped to Insights.
// ../api + ../auth + expo-router mocked; ../context PARTIALLY mocked (real selectors,
// stubbed useAppContext for the AI card) so ../queries' real imports still resolve.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockAuthStatus = 'authed';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (l: () => void) => {
    mockAuthListeners.add(l);
    return () => mockAuthListeners.delete(l);
  },
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

const mockFetchBreakdown = jest.fn<(days: number, cycle?: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number, number?])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

// Stub only useAppContext (the AI card); keep the real categoryBreakdown/cycleClock/
// toCategory that ../queries and the screen import.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      aiInsights: null,
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
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockFetchBreakdown.mockReset().mockResolvedValue(BREAKDOWN);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
});

it('renders breakdown rows from the query, fetched in parallel with the pay cycle', async () => {
  renderInsights();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  // WHIT-72: breakdown fetches in PARALLEL now (flat key, no gate) → fires with the default
  // length (14); the server derives the window itself, so the rows are correct regardless.
  // WHIT-68: the current cycle is 0.
  expect(mockFetchBreakdown).toHaveBeenCalledWith(14, 0);
  expect(mockFetchBreakdown).toHaveBeenCalledTimes(1);
});

it('does not fetch breakdown before login, then fires when auth flips to authed', async () => {
  mockAuthStatus = 'anon';
  renderInsights();
  expect(mockFetchBreakdown).not.toHaveBeenCalled();
  expect(mockFetchPayCycle).not.toHaveBeenCalled();

  await act(async () => {
    setAuth('authed');
  });
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(mockFetchBreakdown).toHaveBeenCalled();
});

it('a transient 5xx on breakdown retries and self-heals — no error shown', async () => {
  mockFetchBreakdown.mockReset().mockRejectedValueOnce(new Error('API error: 503')).mockResolvedValue(BREAKDOWN);
  renderInsights(makeClient(2));
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByTestId('insights-error')).toBeNull();
  expect(mockFetchBreakdown).toHaveBeenCalledTimes(2);
});

it('a sustained breakdown failure shows the inline error + Retry, no false $0', async () => {
  mockFetchBreakdown.mockReset().mockRejectedValue(new Error('API error: 503'));
  renderInsights(makeClient(false));
  expect(await screen.findByTestId('insights-error')).toBeTruthy();
  expect(screen.queryByText('$0')).toBeNull(); // hero shows "—", not a confident zero

  mockFetchBreakdown.mockReset().mockResolvedValue(BREAKDOWN);
  fireEvent.press(screen.getByTestId('insights-retry'));
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
});

// --- WHIT-68: historical look-back selector ----------------------------------

it('the cycle selector reads the prior cycle, relabels the hero, and hides the AI coach', async () => {
  mockFetchBreakdown.mockReset().mockImplementation((_days: number, cycle = 0) =>
    Promise.resolve(cycle === 1 ? { coffee: { posted: 5, pending: 0 } } : BREAKDOWN));
  renderInsights();

  // current cycle: "THIS PAY CYCLE" eyebrow + the AI coach card present
  expect(await screen.findByText('THIS PAY CYCLE')).toBeTruthy();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Worth a look')).toBeTruthy();

  fireEvent.press(screen.getByTestId('insights-cycle-prev'));

  expect(await screen.findByText('LAST PAY CYCLE')).toBeTruthy();
  // The prior-cycle read fired with cycle=1; the `days` arg is inconsequential (the server
  // derives the window) and varies with whether the pay cycle has resolved, so don't pin it.
  expect(mockFetchBreakdown).toHaveBeenCalledWith(expect.any(Number), 1);
  expect(screen.queryByText('Worth a look')).toBeNull();   // AI coach hidden on a past cycle

  // back to "This cycle" — served from cache (no new fetch), label + coach return
  const callsBefore = mockFetchBreakdown.mock.calls.length;
  fireEvent.press(screen.getByTestId('insights-cycle-current'));
  expect(await screen.findByText('THIS PAY CYCLE')).toBeTruthy();
  expect(screen.getByText('Worth a look')).toBeTruthy();
  expect(mockFetchBreakdown.mock.calls.length).toBe(callsBefore); // cycle 0 already cached
});

it('an empty past cycle shows "No spending in that pay cycle" (not "this pay cycle")', async () => {
  mockFetchBreakdown.mockReset().mockImplementation((_days: number, cycle = 0) =>
    Promise.resolve(cycle === 1 ? {} : BREAKDOWN));
  renderInsights();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();

  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  expect(await screen.findByText('No spending in that pay cycle.')).toBeTruthy();
  expect(screen.queryByText('No spending yet this pay cycle.')).toBeNull();
});
