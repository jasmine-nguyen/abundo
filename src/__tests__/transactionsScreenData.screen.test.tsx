// WHIT-190a — the Transactions real-query regime, consolidated (WHIT-459 fold). THREE folds:
//  • useTransactionsScreenData composite gaps: the refetchStale isStale gate + the isError OR
//    across both reads (renderHook, real QueryClient).
//  • the feed composite's cursor pagination + "keep history, fast" refresh (renderHook).
//  • the Transactions screen on the real query layer (RENDERS the screen).
// ../auth + ../api are mocked for ALL three. ../context (PARTIAL) + expo-router are mocked at
// module scope for the screen-render describe; they are INERT for the two renderHook describes,
// which render no screen (useAppContext is never consulted; the composite hook returns
// refetchStale for a consumer to wire to useFocusEffect and never calls expo-router itself).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, renderHook, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transaction } from '../context';

// ../auth — mutable status (superset: supports the screen-render auth-flip test). INERT for the
// renderHook describes: their beforeEach re-seeds 'authed' and no test calls setAuth, so the
// listener Set never fires — behaviourally identical to a static `() => 'authed'` stub.
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

// ../api — one factory over the union surface (feed + recent + categories + balances). Each
// describe aliases these to its own local names; the factory passes the cursor through so the
// feed describe's `toHaveBeenNthCalledWith(2, 'cur1')` still holds.
const mockFetchTransactionsFeed = jest.fn<(cursor?: string) => Promise<unknown>>();
const mockFetchCategories = jest.fn<() => Promise<unknown>>();
const mockFetchTransactions = jest.fn<() => Promise<unknown>>();
const mockFetchAccountBalances = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchTransactionsFeed: (cursor?: string) => mockFetchTransactionsFeed(cursor),
  fetchCategories: () => mockFetchCategories(),
  fetchTransactions: () => mockFetchTransactions(),
  fetchAccountBalances: () => mockFetchAccountBalances(),
}));

const CATS = [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', recent: 0 }];

// ../context — PARTIALLY mocked (real selectors, stubbed useAppContext for TransactionRow +
// retryLoad) so ../queries' real imports still resolve; the screen renders under a real
// QueryClientProvider. INERT for the renderHook describes (they never mount a component that
// reads useAppContext; every other export passes through requireActual).
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ retryLoad: jest.fn(), category: (id: string | null) => CATS.find((c) => c.id === id) }),
  };
});

// expo-router — mocked for the screen render. INERT for the renderHook describes (the composite
// hook does not import expo-router; it returns refetchStale for the screen to wire to focus).
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import { useTransactionsScreenData, useRecentTransactionsScreenData } from '../queries';
import Transactions from '../../app/(tabs)/transactions';

const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

function wrapper(client: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
}

describe('useTransactionsScreenData composite (WHIT-190a gaps)', () => {
  function makeClient(staleTime: number) {
    return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
  }

  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
    mockFetchTransactionsFeed.mockReset().mockResolvedValue({ transactions: TXNS, nextCursor: null });
    mockFetchCategories.mockReset().mockResolvedValue(CATS);
  });

  it('refetchStale no-ops on a FRESH cache (instant-from-cache on revisit)', async () => {
    const client = makeClient(Infinity); // never stale
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(mockFetchTransactionsFeed).toHaveBeenCalledTimes(1);

    act(() => { result.current.refetchStale(); });
    await act(async () => { await Promise.resolve(); }); // flush any (non-)refetch microtask
    expect(mockFetchTransactionsFeed).toHaveBeenCalledTimes(1); // fresh → no refetch
    expect(mockFetchCategories).toHaveBeenCalledTimes(1);
  });

  it('refetchStale REFETCHES a STALE single-page cache (focus refresh re-checks the newest page)', async () => {
    const client = makeClient(0); // immediately stale
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(mockFetchTransactionsFeed).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.refetchStale(); });
    await waitFor(() => expect(mockFetchTransactionsFeed).toHaveBeenCalledTimes(2));
  });

  it('isError surfaces when ONLY the categories read fails (transactions still populated)', async () => {
    mockFetchCategories.mockReset().mockRejectedValue(new Error('API error: 500'));
    const client = makeClient(Infinity); // retry:false
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.transactions.length).toBe(1); // tx loaded despite categories failing
  });
});

// ===== WHIT-190a (folded from transactionsFeed.screen.test.tsx) =====
// The Transactions tab feed composite (useTransactionsScreenData) — cursor pagination plus the
// approved "keep history, fast" refresh. Real QueryClient + renderHook; ../api + ../auth mocked.
// Locks: newest page first, Load More appends the next (older) page via the prior cursor,
// hasMore flips false at end-of-history, a manual pull snaps back to the newest page (no N-page
// storm), a focus refresh leaves paged-in history untouched, and the bounded recent hook reads
// its OWN endpoint (Decision 2 — the dot/account counts can't drift with feed depth).
describe('the Transactions tab feed composite — pagination + refresh', () => {
  const tx = (id: string): Transaction => ({
    transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
    description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
    account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
  });
  const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);
  const mockFeed = mockFetchTransactionsFeed;
  const mockRecent = mockFetchTransactions;
  const mockCategories = mockFetchCategories;
  const mockBalances = mockFetchAccountBalances;

  function makeClient(staleTime = 60_000) {
    return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime, gcTime: Infinity } } });
  }

  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
    mockFeed.mockReset();
    mockRecent.mockReset().mockResolvedValue([]);
    mockCategories.mockReset().mockResolvedValue([]);
    mockBalances.mockReset().mockResolvedValue([]);
  });

  it('loads the newest page first, then Load More appends the next (older) page', async () => {
    mockFeed
      .mockResolvedValueOnce({ transactions: [tx('t1'), tx('t2')], nextCursor: 'cur1' })
      .mockResolvedValueOnce({ transactions: [tx('t3')], nextCursor: null });
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.transactions.length).toBe(2));
    expect(result.current.hasMore).toBe(true);

    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(3));
    expect(ids(result.current.transactions)).toEqual(['t1', 't2', 't3']); // appended, order preserved
    expect(result.current.hasMore).toBe(false); // nextCursor null → end of history
    expect(mockFeed).toHaveBeenNthCalledWith(2, 'cur1'); // page 2 fetched with page 1's cursor
  });

  it('a manual pull SNAPS to the newest page — trims loaded history, refetches page 1 only', async () => {
    mockFeed
      .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' })
      .mockResolvedValueOnce({ transactions: [tx('t2')], nextCursor: 'cur2' }) // page 2
      .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' }); // pull → page 1 fresh
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(2)); // 2 pages loaded

    await act(async () => { result.current.refetch(); }); // manual pull
    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['t1'])); // snapped to newest
    expect(mockFeed).toHaveBeenLastCalledWith(undefined); // fetched page 1, NOT the accumulated pages
  });

  it('refetchStale re-checks the loaded pages in place on return, keeping the user place', async () => {
    mockFeed
      .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' })
      .mockResolvedValueOnce({ transactions: [tx('t2')], nextCursor: null })
      // focus refetch re-fetches BOTH loaded pages by their own cursors:
      .mockResolvedValueOnce({ transactions: [tx('t1')], nextCursor: 'cur1' })
      .mockResolvedValueOnce({ transactions: [tx('t2')], nextCursor: null });
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient(0)) }); // stale
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(2)); // 2 pages
    const callsBefore = mockFeed.mock.calls.length;

    await act(async () => { result.current.refetchStale(); });
    await waitFor(() => expect(mockFeed.mock.calls.length).toBeGreaterThan(callsBefore)); // re-checked the newest
    expect(ids(result.current.transactions)).toEqual(['t1', 't2']); // BOTH pages kept — user's place intact
  });

  it('the bounded recent hook reads its OWN endpoint, not the feed (Decision 2 separation)', async () => {
    mockFeed.mockResolvedValue({ transactions: [tx('f1')], nextCursor: null });
    mockRecent.mockResolvedValue([tx('r1')]);
    const { result } = renderHook(() => useRecentTransactionsScreenData(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(result.current.transactions[0].transaction_id).toBe('r1'); // from fetchTransactions, not the feed
    expect(mockFeed).not.toHaveBeenCalled(); // the recent hook never touches the feed cache
  });
});

// ===== WHIT-190a (folded from transactionsQuery.screen.test.tsx) =====
// The Transactions list on the real query layer: rows come from the auth-gated ['transactions']
// query (not fetched before login), a transient 5xx self-heals, a sustained failure shows an
// inline Retry, cache-first on revisit. ../api + ../auth + expo-router mocked; ../context
// PARTIALLY mocked (all above, at module scope); the screen renders under a real
// QueryClientProvider.
describe('the Transactions list on the real query layer (WHIT-190a)', () => {
  function makeClient(retry: boolean | number = false) {
    return new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 1, staleTime: 60_000, gcTime: Infinity } } });
  }
  function renderTransactions(client = makeClient()) {
    return render(React.createElement(QueryClientProvider, { client }, React.createElement(Transactions)));
  }

  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
    mockFetchTransactionsFeed.mockReset().mockResolvedValue({ transactions: TXNS, nextCursor: null });
    mockFetchCategories.mockReset().mockResolvedValue(CATS);
  });

  it('renders transaction rows from the query', async () => {
    renderTransactions();
    expect(await screen.findByText('-$42.00')).toBeTruthy(); // the query-fed row rendered
    expect(mockFetchTransactionsFeed).toHaveBeenCalledTimes(1);
    expect(mockFetchCategories).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner first, then the rows (cache-first)', async () => {
    renderTransactions();
    expect(screen.getByTestId('transactions-loading')).toBeTruthy();
    expect(await screen.findByText('-$42.00')).toBeTruthy();
  });

  it('a transient 5xx retries and self-heals — no error shown', async () => {
    mockFetchTransactionsFeed.mockReset().mockRejectedValueOnce(new Error('API error: 503')).mockResolvedValue({ transactions: TXNS, nextCursor: null });
    renderTransactions(makeClient(2));
    expect(await screen.findByText('-$42.00')).toBeTruthy();
    expect(screen.queryByTestId('transactions-error')).toBeNull();
    expect(mockFetchTransactionsFeed).toHaveBeenCalledTimes(2);
  });

  it('a sustained failure shows the inline error, and Retry recovers', async () => {
    mockFetchTransactionsFeed.mockReset().mockRejectedValue(new Error('API error: 503'));
    renderTransactions(makeClient(false));
    expect(await screen.findByTestId('transactions-error')).toBeTruthy();

    // WHIT-198 GAP (authored by qa) — the retry now routes through the shared RetryButton, so it
    // must carry the button role + a screen-reader label a bare Pressable lacked. Locks this
    // migrated screen the way budgetsQuery locks Budgets, so a revert to `<Pressable>` is caught.
    const retry = screen.getByTestId('transactions-retry');
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.accessibilityLabel).toBe('Retry loading your transactions');

    mockFetchTransactionsFeed.mockReset().mockResolvedValue({ transactions: TXNS, nextCursor: null });
    fireEvent.press(retry);
    expect(await screen.findByText('-$42.00')).toBeTruthy();
  });

  it('does not fetch before login, then fires on auth flip to authed', async () => {
    mockAuthStatus = 'anon';
    renderTransactions();
    expect(mockFetchTransactionsFeed).not.toHaveBeenCalled();

    await act(async () => {
      setAuth('authed');
    });
    expect(await screen.findByText('-$42.00')).toBeTruthy();
    expect(mockFetchTransactionsFeed).toHaveBeenCalled();
  });
});
