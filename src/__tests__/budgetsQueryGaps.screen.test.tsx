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
    expect(mockFetchBudgets).toHaveBeenCalledWith(30); // pay cycle succeeded → real length
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
  it("invalidate ['budgets'] prefix refetches the windowed ['budgets', 30] entry", async () => {
    // edit.tsx invalidates the module-singleton queryClient (same instance _layout mounts
    // — a static import, so identity is guaranteed). Behaviourally, prefix-invalidating
    // ['budgets'] must refetch the windowed ['budgets', 30] entry; a local client with no
    // gcTime timer proves that without leaking a background timer into the worker.
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

// Regression lock for the isLoading fix (code-critic/qa #1): a sustained payCycle
// failure leaves the budgets query disabled; a disabled v5 query is isPending:true, so
// basing the spinner on isPending stranded the user on an endless spinner with no Retry.
describe('payCycle failure must not strand a spinner', () => {
  it('sustained payCycle failure → inline error + Retry, never an endless spinner', async () => {
    mockFetchPayCycle.mockReset().mockRejectedValue(new Error('API error: 503'));
    renderBudgets(makeClient(false));
    expect(await screen.findByTestId('budgets-error')).toBeTruthy();
    expect(screen.getByTestId('budgets-retry')).toBeTruthy();
    expect(screen.queryByTestId('budgets-loading')).toBeNull();
  });
});
