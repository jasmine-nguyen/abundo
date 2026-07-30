// WHIT-380 (QA gap) — the income-source filter's RECONCILE_EPSILON boundary in
// useInsightsScreenData (src/queries.ts). The implementer's insightsScreenData.edges.screen.test.tsx
// locks the COARSE cases: an EXACT-$0-net source is dropped and a −$150 source is kept. Neither
// brackets the half-cent threshold — a mutation from `>= RECONCILE_EPSILON` to a bare `!== 0`
// (or `> 0`) would STILL pass that test (0 dropped, −150 kept). After WHIT-380 this filter shares
// the SAME constant as the two reconciliation plugs, so a bump/rename must redden a test here too.
// These two cases bracket 0.005: a sub-half-cent net (either sign) is DROPPED as dust; a net just
// OVER the half-cent is KEPT. Mirrors the render-side pattern of the file it supplements.
// Fail-on-revert (proven): `>= RECONCILE_EPSILON` → `!== 0` keeps the dust sources (length 4) →
// reddens; bump RECONCILE_EPSILON to 0.01 drops the −0.006 source → reddens.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFetchBreakdown = jest.fn<(days: number, cycle?: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
const mockFetchBudgets = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBreakdown: (...a: unknown[]) => mockFetchBreakdown(...(a as [number, number?])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
  fetchBudgets: () => mockFetchBudgets(),
}));

import { useInsightsScreenData } from '../queries';

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchBreakdown.mockReset();
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
  mockFetchBudgets.mockReset().mockResolvedValue({});
});

it('drops a sub-half-cent net source (either sign) as float dust but keeps a net just OVER the half-cent', () => {
  mockFetchBreakdown.mockResolvedValue({
    coffee: { posted: 40, pending: 10 },
    __earned__: { posted: 5000, pending: 0 },
    __income__: {
      salary: { posted: 5000, pending: 0 },   // real → kept, first
      dustpos: { posted: 0.004, pending: 0 }, // |0.004| < 0.005 → dropped
      dustneg: { posted: -0.003, pending: 0 },// |0.003| < 0.005 → dropped (a tiny-negative is NOT kept)
      keepneg: { posted: -0.006, pending: 0 },// |0.006| >= 0.005 → kept, sorts last (negative)
    },
  });
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  return waitFor(() => expect(result.current.incomeSources.length).toBe(2)).then(() => {
    // Only salary and keepneg survive; both dust sources are gone.
    expect(result.current.incomeSources.map((s) => s.id)).toEqual(['salary', 'keepneg']);
    expect(result.current.incomeSources.find((s) => s.id === 'keepneg')?.amount).toBeCloseTo(-0.006, 6);
    expect(result.current.incomeSources.some((s) => s.id === 'dustpos' || s.id === 'dustneg')).toBe(false);
  });
});
