// WHIT-189 GAPS on the REAL query layer (adversarial half, authored by qa). Complements
// insightsBreakdownQuery.screen.test.tsx (happy path + self-heal) with the paths the
// implementer left open: partial failure (categories down while breakdown is fine — the
// misleading-partial-list edge), the focus refetch not storming, and an authed→locked
// mid-session on Insights. Mock pattern mirrors budgetsQueryGaps: ../api + ../auth +
// expo-router mocked; ../context PARTIALLY mocked (real selectors, stub AI store); the
// screen renders under a real QueryClientProvider so actual query behaviour runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
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

const mockFetchBreakdown = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

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
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]) };
});

import Insights from '../../app/(tabs)/insights';
import { UNCATEGORIZED_KEY } from '../context';

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

describe('partial failure: categories down while breakdown succeeds', () => {
  // With no taxonomy, categoryBreakdown drops every REAL-category row (category(id) is
  // undefined) but the Uncategorized bucket needs no taxonomy, so it survives. Because a
  // surviving row makes rows.length > 0, the inline error is suppressed and the screen
  // shows a MISLEADING partial list + a hero total that omits the real categories. This
  // test pins that ACTUAL behaviour (see the qa critique — flagged as a real bug,
  // acceptable-for-scope pending WHIT-193 proper invalidation/coupling).
  it('breakdown has real + uncategorized spend → only Uncategorized survives, and NO error is shown (misleading partial)', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    mockFetchBreakdown.mockReset().mockResolvedValue({ coffee: { posted: 40, pending: 0 }, [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 } });
    renderInsights(makeClient(false));
    expect(await screen.findByText('Uncategorized')).toBeTruthy();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull(); // real row dropped (no taxonomy)
    expect(screen.queryByTestId('insights-error')).toBeNull(); // surviving uncat row hides the error
    // hero total is $25 (uncat only), NOT the full $65 — the real $40 is silently omitted.
    expect(screen.queryByText('$65')).toBeNull();
    expect(screen.getAllByText('$25').length).toBeGreaterThanOrEqual(1);
  });

  it('breakdown has ONLY real-category spend → all rows drop → the inline error DOES surface', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    // breakdown resolves fine but every id needs the (failed) taxonomy → zero rows.
    renderInsights(makeClient(false));
    expect(await screen.findByTestId('insights-error')).toBeTruthy();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
    expect(screen.queryByText('$0')).toBeNull(); // hero must not lie with a confident $0
  });
});

describe('focus refetch does not storm', () => {
  it('fresh data + focus effect (staleTime 60s) → each fetcher called exactly once', async () => {
    renderInsights();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchPayCycle).toHaveBeenCalledTimes(1);
    expect(mockFetchBreakdown).toHaveBeenCalledTimes(1);
    expect(mockFetchCategories).toHaveBeenCalledTimes(1);
  });
});

describe('auth transition mid-session on Insights', () => {
  it('authed→locked keeps cached rows, shows no error, and fires no doomed refetch', async () => {
    renderInsights();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const before = mockFetchBreakdown.mock.calls.length;

    await act(async () => {
      setAuth('locked');
    });
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy(); // cache survives
    expect(screen.queryByTestId('insights-error')).toBeNull();
    expect(mockFetchBreakdown).toHaveBeenCalledTimes(before); // no new fetch while locked
  });
});
