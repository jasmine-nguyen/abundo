// WHIT-72 GAPS (adversarial half, authored by qa) — the payCycleError signal's
// data===undefined guard, which the implementer's tests only exercise in ONE direction
// (a sustained first-load failure → error). The make-or-break is the CACHE-FIRST case:
// a BACKGROUND pay-cycle refetch failure over an already-cached cycle must NOT blank the
// cached budgets (payCycleError stays false, rows + last-good cycleLen survive), exactly
// like WHIT-194's categoriesError cache-first lock. Plus the first-load TRUE lock at the
// composite level (existing tests only assert the aggregate isError, not payCycleError
// itself) and the both-reads-fail case. ../api + ../auth mocked; real QueryClientProvider
// drives the hooks (mirrors insightsScreenData.edges / screenQueryHooks).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));

const mockFetchBudgets = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
const mockFetchTransactions = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBudgets: (...a: unknown[]) => mockFetchBudgets(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
  fetchTransactions: () => mockFetchTransactions(),
}));

import { useBudgetsScreenData, useBudgetDetailScreenData } from '../queries';

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 }];
const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
const BUDGETS = { coffee: { target: 100, posted: 40, pending: 10 } };

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
}
const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockFetchBudgets.mockReset().mockResolvedValue(BUDGETS);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
  mockFetchTransactions.mockReset().mockResolvedValue([]);
});

describe('useBudgetsScreenData — payCycleError guard (WHIT-72)', () => {
  it('first-load payCycle failure (never-succeeded → data undefined) → payCycleError is TRUE', async () => {
    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // The signal the screen keys its error card on — locked directly (existing tests only
    // assert the aggregate isError). data===undefined ⇒ no cached cycle to trust.
    expect(result.current.payCycleError).toBe(true);
  });

  it('BACKGROUND payCycle refetch failure over a cached cycle → payCycleError stays FALSE, rows + last-good cycle survive (cache-first)', async () => {
    // First load succeeds → cycle (len 30) + budgets cached. Then a refetch of the pay cycle
    // fails: TanStack v5 RETAINS the last-good data, so data!==undefined ⇒ payCycleError must
    // stay FALSE and the rows keep rendering against the last-good cycle. A bare `.isError`
    // (no data guard) would flip this true and blank cached budgets — the exact regression.
    const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.budgets).toHaveLength(1));
    expect(result.current.cycleLen).toBe(30);

    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(result.current.isError).toBe(true)); // the failed payCycle refetch propagates

    expect(result.current.payCycleError).toBe(false); // <-- data retained → NOT a first-load error
    expect(result.current.cycleLen).toBe(30);         // last-good cycle still drives the hero
    expect(result.current.budgets).toHaveLength(1);   // cached rows survive
  });

  it('BOTH payCycle AND budgets fail on first load → error via both paths (payCycleError AND isError)', async () => {
    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    mockFetchBudgets.mockReset().mockRejectedValue(new Error('API error: 500'));
    const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.payCycleError).toBe(true);
    expect(result.current.budgets).toHaveLength(0);
  });
});

describe('useBudgetDetailScreenData — payCycleError guard (WHIT-72)', () => {
  it('BACKGROUND payCycle refetch failure over a cached cycle → payCycleError stays FALSE (cache-first, same guard as Budgets)', async () => {
    const { result } = renderHook(() => useBudgetDetailScreenData(), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.budgets).toHaveLength(1));
    expect(result.current.cycleLen).toBe(30);

    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.payCycleError).toBe(false);
    expect(result.current.cycleLen).toBe(30);
    expect(result.current.budgets).toHaveLength(1);
  });

  it('first-load payCycle failure → payCycleError is TRUE (detail blanks on it)', async () => {
    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    const { result } = renderHook(() => useBudgetDetailScreenData(), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.payCycleError).toBe(true);
  });
});
