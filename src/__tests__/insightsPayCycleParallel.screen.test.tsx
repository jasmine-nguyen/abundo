// WHIT-72 GAP (adversarial half, authored by qa) — the Insights exclusion is only safe if
// the Insights hero is genuinely cycle-INDEPENDENT (categoryBreakdown takes {breakdown,
// category} only). Existing tests prove breakdown FETCHES in parallel (with 14) on a
// payCycle failure, but not that the hero RENDERS while the pay cycle is still pending.
// This locks that: with the pay cycle held unresolved, the breakdown hero still paints its
// total (no waterfall, no cycle-gated hero) — so having no payCycleError on Insights is
// correct. Fail-on-revert: re-gating the breakdown/hero behind the pay cycle strands this on
// "Loading…". ../api + ../auth + expo-router mocked; ../context partially mocked (real
// selectors, stubbed AI slice) — mirrors insightsBreakdownQuery.screen.test.tsx.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
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

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      aiInsights: null, aiInsightsLoading: false, aiInsightsError: false,
      refreshAiInsights: jest.fn(), generateAiInsights: jest.fn(),
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

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}

beforeEach(() => {
  mockFetchBreakdown.mockReset().mockResolvedValue(BREAKDOWN);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue({ length: 30, last_pay_date: '2026-07-01' });
});

it('renders the breakdown hero while the pay cycle is STILL pending (cycle-independent hero → Insights exclusion is safe)', async () => {
  // Hold the pay cycle unresolved; breakdown + categories resolve. The hero must paint its
  // total anyway — it reads breakdown, never the cycle. On a payCycle-gated hero it would sit
  // on "Loading…" until the (never-resolving) cycle landed.
  let resolvePayCycle: (v: unknown) => void = () => {};
  mockFetchPayCycle.mockReset().mockReturnValue(new Promise((r) => { resolvePayCycle = r; }));
  render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(Insights)));

  expect(await screen.findByText('spent across 1 category')).toBeTruthy(); // hero painted from breakdown
  expect(screen.queryByText('Loading…')).toBeNull();
  expect(mockFetchBreakdown).toHaveBeenCalledWith(14, 0); // parallel, default length, current cycle (WHIT-68); server derives the window

  await act(async () => { resolvePayCycle({ length: 30, last_pay_date: '2026-07-01' }); }); // settle to avoid act() leak
});
