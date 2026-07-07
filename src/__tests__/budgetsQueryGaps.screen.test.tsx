// WHIT-188 GAPS (adversarial half, authored by qa) — partial failure, empty state,
// auth-lock, cache invalidation, focus over-fetch, and the payCycle-failure dead-end
// (the regression lock for the isLoading fix: this FAILED before it and passes after).
// Complements budgetsQuery.screen.test.tsx (happy path + self-heal). Same mock pattern:
// ../api + ../auth + expo-router mocked; the screen renders under a real
// QueryClientProvider so the actual query behaviour runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
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

const mockFetchBudgets = jest.fn<(days: number) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchPayCycle = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchBudgets: (...a: unknown[]) => mockFetchBudgets(...(a as [number])),
  fetchCategories: () => mockFetchCategories(),
  fetchPayCycle: () => mockFetchPayCycle(),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
  };
});

import Budgets from '../../app/(tabs)/budgets';

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 }];
const BUDGETS = { coffee: { target: 100, posted: 40, pending: 10 } };

function makeClient(retry: boolean | number = false) {
  return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime: 60_000, gcTime: Infinity } } });
}
function renderBudgets(client = makeClient()) {
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Budgets)));
}

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockAuthListeners.clear();
  mockFetchBudgets.mockReset().mockResolvedValue(BUDGETS);
  mockFetchCategories.mockReset().mockResolvedValue(CATS);
  mockFetchPayCycle.mockReset().mockResolvedValue(PAY_CYCLE);
  mockPush.mockReset();
});

describe('partial failure', () => {
  it('budgets read fails while pay cycle succeeds → inline error + Retry (not a spinner)', async () => {
    mockFetchBudgets.mockReset().mockRejectedValue(new Error('API error: 503'));
    renderBudgets(makeClient(false));
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByTestId('budgets-retry')).toBeTruthy();
    // WHIT-72: budgets fetches in PARALLEL now (not gated on payCycle), so it fires with the
    // DEFAULT length (14) before the cycle resolves — and the flat key means it never
    // refetches to 30. The server ignores the length anyway, so the response is still correct.
    expect(mockFetchBudgets).toHaveBeenCalledWith(14);
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });

  it('categories read fails → inline error (rows cannot render without their category)', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    renderBudgets(makeClient(false));
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
  });
});

describe('empty budgets', () => {
  it('empty rollup {} → empty state (hero + Add a budget), not a spinner or error', async () => {
    mockFetchBudgets.mockReset().mockResolvedValue({});
    renderBudgets();
    expect(await screen.findByText('Add a budget')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
    expect(screen.queryByTestId('budgets-error')).toBeNull();
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();
    expect(screen.getByText('days left')).toBeTruthy(); // hero still renders
  });
});

describe('focus refetch', () => {
  it('does not storm: fresh data + focus effect → each fetcher called exactly once', async () => {
    renderBudgets(); // staleTime 60s → refetchStale is a no-op
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchPayCycle).toHaveBeenCalledTimes(1);
    expect(mockFetchBudgets).toHaveBeenCalledTimes(1);
    expect(mockFetchCategories).toHaveBeenCalledTimes(1);
  });
});

describe('auth transition mid-session', () => {
  it('authed→locked keeps cached rows and fires no new fetch (no doomed 401 retry)', async () => {
    renderBudgets();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const before = mockFetchBudgets.mock.calls.length;

    await act(async () => {
      setAuth('locked');
    });
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    expect(screen.queryByTestId('budgets-error')).toBeNull();
    expect(mockFetchBudgets).toHaveBeenCalledTimes(before);
  });
});

describe('save → cache invalidation', () => {
  it("invalidate ['budgets'] refetches the budgets query", async () => {
    // edit.tsx invalidates the module-singleton queryClient (same instance _layout mounts
    // — a static import, so identity is guaranteed). Behaviourally, invalidating ['budgets']
    // must refetch the (flat, WHIT-72) budgets query; a local client with no gcTime timer
    // proves that without leaking a background timer into the worker.
    const client = makeClient();
    render(React.createElement(QueryClientProvider, { client }, React.createElement(Budgets)));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const before = mockFetchBudgets.mock.calls.length;

    await act(async () => {
      client.invalidateQueries({ queryKey: ['budgets'] }); // what edit.tsx does after a save
    });
    await waitFor(() => expect(mockFetchBudgets.mock.calls.length).toBeGreaterThan(before));
  });
});

// WHIT-72: budgets no longer waterfalls behind the pay cycle.
describe('parallel fetch (no waterfall)', () => {
  it('budgets fetches immediately with the default length, not gated on the pay cycle', async () => {
    // Hold the pay cycle unresolved; budgets must STILL fire (in parallel), with the default
    // length (14). On the OLD gated code fetchBudgets would not be called until payCycle
    // resolved — so this fails on revert.
    let resolvePayCycle: (v: unknown) => void = () => {};
    mockFetchPayCycle.mockReset().mockReturnValue(new Promise((r) => { resolvePayCycle = r; }));
    renderBudgets();

    await waitFor(() => expect(mockFetchBudgets).toHaveBeenCalled());
    expect(mockFetchBudgets).toHaveBeenCalledWith(14);   // default length — cycle not yet loaded
    expect(mockFetchPayCycle).toHaveBeenCalledTimes(1);  // fired in parallel, still pending

    await act(async () => { resolvePayCycle(PAY_CYCLE); }); // settle to avoid an act() leak
  });
});

// WHIT-72: a pay-cycle length change refetches budgets EXACTLY once (the explicit
// invalidate), not twice. With the flat key, writing a new-length pay cycle no longer
// shifts the budgets key, so it doesn't itself trigger a refetch — only the invalidate does.
describe('length change refetches once, not twice', () => {
  it('writing a new-length pay cycle does NOT refetch; the invalidate is the single refresh', async () => {
    const client = makeClient();
    render(React.createElement(QueryClientProvider, { client }, React.createElement(Budgets)));
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const afterLoad = mockFetchBudgets.mock.calls.length;

    // persistPayCycle writes the new-length cycle into the cache. With the flat key this must
    // NOT trigger a budgets refetch on its own (the old windowed key WOULD have — refetch #1).
    await act(async () => {
      client.setQueryData(['payCycle'], { length: 14, last_pay_date: '2026-07-01' });
    });
    await act(async () => { await Promise.resolve(); });
    expect(mockFetchBudgets.mock.calls.length).toBe(afterLoad); // no key-shift refetch

    // ...and the explicit invalidate persistPayCycle fires is the SINGLE refresh.
    await act(async () => { client.invalidateQueries({ queryKey: ['budgets'] }); });
    await waitFor(() => expect(mockFetchBudgets.mock.calls.length).toBe(afterLoad + 1));
  });
});

// A sustained payCycle failure must show the inline error + Retry, never a spinner and never
// budgets-against-a-wrong-cycle. WHIT-72: budgets now fetch in PARALLEL, so on a payCycle
// failure the rows would load (against the DEFAULT cycle) and suppress the old `isError &&
// rows.length === 0` error — the payCycleError signal restores the error here. Fail-on-revert:
// drop payCycleError from showError and this reverts to rendering rows with a wrong days-left.
describe('payCycle failure must show the error, not budgets on a wrong cycle', () => {
  it('sustained payCycle failure → inline error + Retry (payCycleError), never a spinner', async () => {
    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    renderBudgets(makeClient(false));
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByTestId('budgets-retry')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });
});
