// WHIT-668 qa — the focus refresh (refetchStale) must be a STABLE function that still reads the
// LATEST query state. Stable → a screen's useFocusEffect doesn't rerun on every redraw (the tight
// retry loop). Latest → a refetchStale captured on an early render still sees today's
// staleness / search mode (no old data captured earlier that never updated).
// Real ../queries over the fake server; ../auth mocked; each composite is wired to a focus effect
// exactly like the screens (and the expo-router test mock) do: useEffect(() => cb(), [cb]).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React, { useEffect } from 'react';
import { render, renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper, pause } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import {
  useBudgetsScreenData, useBudgetDetailScreenData, useInsightsScreenData, useTransactionsScreenData,
  useRecentTransactionsScreenData, useCategoryTransactionsScreenData, useSettingsScreenData,
  useRulesScreenData, useGoalsScreenData, useGoalScreenData,
} from '../queries';
import { COFFEE } from './support/categories';

const server = installFakeServer();

const READ_PATHS = [
  '/paycycle', '/budgets', '/budgets/coffee/transactions', '/breakdown', '/categories',
  '/categories/coffee/transactions', '/transactions', '/transactions/feed', '/transactions/search',
  '/accounts/balances', '/loanfacts', '/rules', '/goals', '/homeloan', '/repayment', '/milestones',
];

const reads = () => server.requests().filter((r) => r.method === 'GET');

type Composite = { isError: boolean; refetchStale: () => void };
let latestIsError = false;
function FocusedScreen({ useData }: { useData: () => Composite }) {
  const { isError, refetchStale } = useData();
  latestIsError = isError;
  useEffect(() => { refetchStale(); }, [refetchStale]); // the screens' useFocusEffect, as mocked
  return null;
}

const COMPOSITES: [string, () => Composite][] = [
  ['Budgets', () => useBudgetsScreenData()],
  ['Budget detail', () => useBudgetDetailScreenData('coffee')],
  ['Insights', () => useInsightsScreenData(0)],
  ['Transactions / Accounts', () => useTransactionsScreenData()],
  ['Transactions under a search', () => useTransactionsScreenData('all', 'woolies')],
  ['Recent transactions', () => useRecentTransactionsScreenData()],
  ['Category detail', () => useCategoryTransactionsScreenData('coffee', 0)],
  ['Settings', () => useSettingsScreenData()],
  ['Rules', () => useRulesScreenData()],
  ['Goals', () => useGoalsScreenData()],
  ['Goal / Mortgage / Milestone', () => useGoalScreenData()],
];

beforeEach(() => {
  latestIsError = false;
});

describe('a lasting failure on every focus-wired composite sends a bounded number of requests', () => {
  it.each(COMPOSITES)('%s: each read is asked for once, then it stops (WHIT-668) [A1]', async (_name, useData) => {
    READ_PATHS.forEach((path) => server.fail(path, 503));
    render(React.createElement(QueryClientProvider, { client: makeClient() }, React.createElement(FocusedScreen, { useData })));
    await waitFor(() => expect(latestIsError).toBe(true));
    await pause(200);
    const paths = reads().map((r) => r.path.split('?')[0]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toEqual([...new Set(paths)]); // no read was re-asked on a redraw
  });
});

describe('refetch / refetchStale identity (WHIT-668)', () => {
  it('Insights: stable across load, a cycle change and an error [A2]', async () => {
    server.seed('/categories', [{ ...COFFEE }]);
    server.seed('/breakdown', { coffee: { posted: 1, pending: 0 } });
    const { result, rerender } = renderHook(({ cycle }: { cycle: number }) => useInsightsScreenData(cycle), {
      wrapper: wrapper(makeClient()), initialProps: { cycle: 0 },
    });
    const first = { refetch: result.current.refetch, refetchStale: result.current.refetchStale };
    await waitFor(() => expect(result.current.breakdown.coffee).toBeDefined());
    server.fail('/breakdown', 503);
    rerender({ cycle: 1 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.refetchStale).toBe(first.refetchStale);
    expect(result.current.refetch).toBe(first.refetch);
  });

  it('Transactions: refetchStale stable across load and a search starting [A3]', async () => {
    const { result, rerender } = renderHook(({ q }: { q: string }) => useTransactionsScreenData('all', q), {
      wrapper: wrapper(makeClient()), initialProps: { q: '' },
    });
    const first = result.current.refetchStale;
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ q: 'woolies' });
    await waitFor(() => expect(result.current.search.answered).toBe(true));
    expect(result.current.refetchStale).toBe(first);
  });
});

describe('a refetchStale captured early still reads the latest query state', () => {
  it('composite: a first-render refetchStale skips reads that have since loaded fresh [A4]', async () => {
    const { result } = renderHook(() => useBudgetsScreenData(), { wrapper: wrapper(makeClient({ staleTime: Infinity })) });
    const early = result.current.refetchStale; // captured while every read was still pending (stale)
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = reads().length;
    await act(async () => { early(); });
    await pause(20);
    expect(reads()).toHaveLength(before);
  });

  it('composite: a first-render refetchStale re-checks reads that have since gone stale [A5]', async () => {
    const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
    const early = result.current.refetchStale;
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(server.sent('GET', '/rules')).toHaveLength(1);
    await act(async () => { early(); });
    await waitFor(() => expect(server.sent('GET', '/rules')).toHaveLength(2));
  });

  it('Transactions: a pre-search refetchStale refreshes the SEARCH (not the feed) once a search is active [A6]', async () => {
    const { result, rerender } = renderHook(({ q }: { q: string }) => useTransactionsScreenData('all', q), {
      wrapper: wrapper(makeClient({ staleTime: 0 })), initialProps: { q: '' },
    });
    const early = result.current.refetchStale;
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ q: 'woolies' });
    await waitFor(() => expect(result.current.search.answered).toBe(true));
    const feedBefore = server.sentUnder('GET', '/transactions/feed').length;
    const searchBefore = server.sentUnder('GET', '/transactions/search').length;
    await act(async () => { early(); });
    await waitFor(() => expect(server.sentUnder('GET', '/transactions/search')).toHaveLength(searchBefore + 1));
    expect(server.sentUnder('GET', '/transactions/feed')).toHaveLength(feedBefore);
  });

  it('Transactions: a mid-search refetchStale refreshes the FEED once the search is cleared [A7]', async () => {
    const { result, rerender } = renderHook(({ q }: { q: string }) => useTransactionsScreenData('all', q), {
      wrapper: wrapper(makeClient({ staleTime: 0 })), initialProps: { q: 'woolies' },
    });
    const early = result.current.refetchStale;
    await waitFor(() => expect(result.current.search.answered).toBe(true));
    rerender({ q: '' });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await pause(20);
    const feedBefore = server.sentUnder('GET', '/transactions/feed').length;
    await act(async () => { early(); });
    await waitFor(() => expect(server.sentUnder('GET', '/transactions/feed')).toHaveLength(feedBefore + 1));
  });
});

describe('after a lasting failure, a real focus / Retry still asks again', () => {
  it('a focus (refetchStale) re-asks the errored read exactly once [A8]', async () => {
    server.fail('/breakdown', 503);
    const { result } = renderHook(() => useInsightsScreenData(0), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    await pause(100);
    expect(server.sentUnder('GET', '/breakdown')).toHaveLength(1);
    await act(async () => { result.current.refetchStale(); });
    await pause(100);
    expect(server.sentUnder('GET', '/breakdown')).toHaveLength(2);
    expect(server.sent('GET', '/categories')).toHaveLength(1); // fresh reads stay untouched
  });

  it('Retry (refetch) fires every read, even fresh ones [A9]', async () => {
    server.fail('/breakdown', 503);
    const { result } = renderHook(() => useInsightsScreenData(0), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(server.sent('GET', '/categories')).toHaveLength(2));
    expect(server.sentUnder('GET', '/breakdown')).toHaveLength(2);
    expect(server.sent('GET', '/paycycle')).toHaveLength(0);
  });
});
