// WHIT-190a — the Transactions real-query regime, consolidated (WHIT-459 fold). THREE folds:
//  • useTransactionsScreenData composite gaps: the refetchStale isStale gate + the isError OR
//    across both reads (renderHook, real QueryClient).
//  • the feed composite's cursor pagination + "keep history, fast" refresh (renderHook).
//  • the Transactions screen on the real query layer (RENDERS the screen).
// Real ../api over the fake server and a mocked ../auth for ALL of them. ../context (PARTIAL) +
// expo-router are mocked at module scope for the screen-render describe; they are INERT for the two renderHook describes,
// which render no screen (useAppContext is never consulted; the composite hook returns
// refetchStale for a consumer to wire to useFocusEffect and never calls expo-router itself).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { RefreshControl } from 'react-native';
import { render, renderHook, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper, pause } from './support/queryClient';
import type { Transaction } from '../types';
import { installFakeServer } from './support/fakeServer';

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
  getAuthToken: async () => 'test-id-token',
}));
function setAuth(next: string) {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

const mockShowToast = jest.fn<(m: string) => void>();

const mockCategories = [{ ...GROCERIES_RECORD, color: '#7FD49B', recent: 0 }];

// ../context — PARTIALLY mocked (real selectors, stubbed useAppContext for TransactionRow +
// retryLoad) so ../queries' real imports still resolve; the screen renders under a real
// QueryClientProvider. INERT for the renderHook describes (they never mount a component that
// reads useAppContext; every other export passes through requireActual).
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({ retryLoad: jest.fn(), openMultiPicker: jest.fn(), showToast: mockShowToast, category: (id: string | null) => mockCategories.find((c) => c.id === id) }),
  };
});

// expo-router — mocked for the screen render. INERT for the renderHook describes (the composite
// hook does not import expo-router; it returns refetchStale for the screen to wire to focus).
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import { useTransactionsScreenData, useRecentTransactionsScreenData, useTransactionDetailScreenData, accountBalancesKey, transactionsSearchKey } from '../queries';
import Transactions from '../../app/(tabs)/transactions';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();
const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const BALANCES = '/accounts/balances';
const REFRESH = '/accounts/balances/refresh';
const feedReads = () => server.sentUnder('GET', FEED);
const uncategorizedReads = () => server.sentUnder('GET', UNCATEGORIZED_FEED);
const categoryReads = () => server.sent('GET', '/categories');
const balanceReads = () => server.sent('GET', BALANCES);
const liveRefreshes = () => server.sent('POST', REFRESH);

const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

describe('useTransactionsScreenData composite (WHIT-190a gaps)', () => {
  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
    server.seed(FEED, { transactions: TXNS, nextCursor: null });
    server.seed('/categories', mockCategories);
  });

  it('refetchStale no-ops on a FRESH cache (instant-from-cache on revisit)', async () => {
    const client = makeClient({ staleTime: Infinity }); // never stale
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(feedReads()).toHaveLength(1);

    act(() => { result.current.refetchStale(); });
    await act(async () => { await Promise.resolve(); }); // flush any (non-)refetch microtask
    expect(feedReads()).toHaveLength(1); // fresh → no refetch
    expect(categoryReads()).toHaveLength(1);
  });

  it('refetchStale REFETCHES a STALE single-page cache (focus refresh re-checks the newest page)', async () => {
    const client = makeClient({ staleTime: 0 }); // immediately stale
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(feedReads()).toHaveLength(1);

    await act(async () => { result.current.refetchStale(); });
    await waitFor(() => expect(feedReads()).toHaveLength(2));
  });

  it('inline Retry (refetch) re-reads the STORED account balances past staleTime', async () => {
    // refetch backs the inline Retry button; the live bank call is pull-only (refreshLiveBalances).
    // Infinity-stale client: balances is never stale, so only an UNCONDITIONAL (forced) refetch
    // refires the stored GET — proving Retry re-reads balances past the 45s window.
    server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]);
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.balances.get('a1')).toBeTruthy());
    expect(balanceReads()).toHaveLength(1); // initial load

    act(() => { result.current.refetch(); });
    await waitFor(() => expect(balanceReads()).toHaveLength(2)); // Retry forced the re-read
    expect(liveRefreshes()).toHaveLength(0); // Retry never makes the paid live call
  });

  it('pull (refreshLiveBalances) fetches LIVE balances via the refresh endpoint and seeds the cards', async () => {
    // Pull calls the live-refresh POST (not the stored GET) and seeds the cache with its result, so
    // the Accounts cards show the freshly-fetched numbers. Infinity-stale client proves it's the POST
    // updating them, not a staleness-driven GET — and that the stored GET is NOT fired again on pull.
    server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]); // stored (initial)
    server.once('POST', REFRESH, { body: [{ account_id: 'a1', amount: -250 }] }); // live POST result
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.balances.get('a1')).toBeTruthy());
    expect(balanceReads()).toHaveLength(1); // initial stored load
    const feedCallsBefore = feedReads().length;

    await act(async () => {
      await Promise.all([result.current.refetchList(), result.current.refreshLiveBalances()]);
    });

    // The cards show the freshly-fetched number (the live POST seeded the cache).
    await waitFor(() => expect(result.current.balances.get('a1')?.amount).toBe(-250));
    expect(liveRefreshes()).toHaveLength(1);                     // the LIVE call fired
    expect(balanceReads()).toHaveLength(1);                      // NOT a second stored GET
    expect(feedReads().length).toBeGreaterThan(feedCallsBefore); // list refreshed too
  });

  it('pull (refetchList) invalidates the whole-history uncategorized count (badge/dot refresh on pull)', async () => {
    // WHIT-501: a pull loads brand-new unfiled rows into the list, so it must also refresh the
    // server tally that drives the badge/dot — otherwise the number stays fresh-cached (5min) and
    // disagrees with the rows the pull just brought in.
    // Fail-on-revert: drop the uncategorizedCount invalidate from refetchList → this key is no
    // longer passed to invalidateQueries and the assertion fails.
    const client = makeClient({ staleTime: Infinity });
    const spy = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));

    await act(async () => { await result.current.refetchList(); });

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0]);
    expect(keys).toContain('uncategorizedCount');
    spy.mockRestore();
  });

  it('focus refresh (refetchStale) never force-refetches balances — even when everything is stale (scope guard)', async () => {
    // The 45s-bypass is a PULL-only power. On focus we re-check the feed/taxonomy in place, but the
    // poller-fed balances must NOT ride along — else every tab-return hammers the balances endpoint.
    // staleTime:0 makes the feed itself stale (so refetchStale DOES refire it), proving balances is
    // skipped by design here, not merely because it happened to be fresh.
    server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]);
    const client = makeClient({ staleTime: 0 }); // everything immediately stale
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.balances.get('a1')).toBeTruthy());
    expect(balanceReads()).toHaveLength(1);
    expect(feedReads()).toHaveLength(1);

    await act(async () => { result.current.refetchStale(); });
    await waitFor(() => expect(feedReads()).toHaveLength(2)); // stale feed WAS re-checked
    expect(balanceReads()).toHaveLength(1); // balances deliberately left alone
  });

  it('a stored-balances refetch FAILURE (Retry) leaves the transaction list intact — isError false, rows stay, last balance kept', async () => {
    // refetch (Retry) re-reads balances, but balances is secondary: if that forced refetch rejects,
    // the composite must not surface it. isError stays false, the feed rows stay, and react-query
    // keeps the last-good balance (no card blanks mid-refetch).
    server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]); // initial load OK
    const client = makeClient({ staleTime: Infinity }); // retry:false
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.balances.get('a1')).toBeTruthy());
    expect(result.current.isError).toBe(false);

    server.fail(BALANCES, 503); // the pull-forced refetch fails
    act(() => { result.current.refetch(); });
    await waitFor(() => expect(balanceReads()).toHaveLength(2)); // Retry forced the re-read
    await waitFor(() => expect(client.getQueryState(accountBalancesKey)?.status).toBe('error')); // it truly failed
    expect(result.current.isError).toBe(false);           // ...yet the list status is unaffected
    expect(result.current.transactions.length).toBe(1);   // rows still there
    expect(result.current.balances.get('a1')).toBeTruthy(); // last-good balance retained (not blanked)
  });

  it('isError surfaces when ONLY the categories read fails (transactions still populated)', async () => {
    server.fail('/categories', 500);
    const client = makeClient({ staleTime: Infinity }); // retry:false
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.transactions.length).toBe(1); // tx loaded despite categories failing
  });
});

// ===== WHIT-190a (folded from transactionsFeed.screen.test.tsx) =====
// The Transactions tab feed composite (useTransactionsScreenData) — cursor pagination plus the
// approved "keep history, fast" refresh. Real QueryClient + renderHook; real ../api, ../auth mocked.
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
  const page = (transactions: Transaction[], nextCursor: string | null) => ({ body: { transactions, nextCursor } });

  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
  });

  it('loads the newest page first, then Load More appends the next (older) page', async () => {
    server.once('GET', FEED, page([tx('t1'), tx('t2')], 'cur1'));
    server.once('GET', FEED, page([tx('t3')], null));
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.transactions.length).toBe(2));
    expect(result.current.hasMore).toBe(true);

    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(3));
    expect(ids(result.current.transactions)).toEqual(['t1', 't2', 't3']); // appended, order preserved
    expect(result.current.hasMore).toBe(false); // nextCursor null → end of history
    expect(feedReads()[1]?.path).toBe('/transactions/feed?cursor=cur1'); // page 2 fetched with page 1's cursor
  });

  it('a manual pull SNAPS to the newest page — trims loaded history, refetches page 1 only', async () => {
    server.once('GET', FEED, page([tx('t1')], 'cur1'));
    server.once('GET', FEED, page([tx('t2')], 'cur2')); // page 2
    server.once('GET', FEED, page([tx('t1')], 'cur1')); // pull → page 1 fresh
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(2)); // 2 pages loaded

    await act(async () => { result.current.refetch(); }); // manual pull
    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['t1'])); // snapped to newest
    expect(feedReads().at(-1)?.path).toBe(FEED); // fetched page 1 (no cursor), NOT the accumulated pages
  });

  it('refetchStale re-checks the loaded pages in place on return, keeping the user place', async () => {
    server.once('GET', FEED, page([tx('t1')], 'cur1'));
    server.once('GET', FEED, page([tx('t2')], null));
    // focus refetch re-fetches BOTH loaded pages by their own cursors:
    server.once('GET', FEED, page([tx('t1')], 'cur1'));
    server.once('GET', FEED, page([tx('t2')], null));
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(makeClient({ staleTime: 0 })) }); // stale
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(2)); // 2 pages
    const callsBefore = feedReads().length;

    await act(async () => { result.current.refetchStale(); });
    await waitFor(() => expect(feedReads().length).toBeGreaterThan(callsBefore)); // re-checked the newest
    expect(ids(result.current.transactions)).toEqual(['t1', 't2']); // BOTH pages kept — user's place intact
  });

  it('the bounded recent hook reads its OWN endpoint, not the feed (Decision 2 separation)', async () => {
    server.seed(FEED, { transactions: [tx('f1')], nextCursor: null });
    server.seed('/transactions', [tx('r1')]);
    const { result } = renderHook(() => useRecentTransactionsScreenData(), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(result.current.transactions[0].transaction_id).toBe('r1'); // from fetchTransactions, not the feed
    expect(feedReads()).toHaveLength(0); // the recent hook never touches the feed cache
  });
});

// The Uncategorized tab drives the SAME composite but with tab='uncategorized', so the list source,
// Load More, and loading/error all swap to the server-filtered uncategorized feed. This is the fix:
// the tab lists real uncategorized rows from history (paged), not the general feed filtered down.
describe('the Uncategorized tab feed composite — server-side paged uncategorized', () => {
  const tx = (id: string): Transaction => ({
    transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
    description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
    account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true,
  });
  const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);
  const page = (transactions: Transaction[], nextCursor: string | null) => ({ body: { transactions, nextCursor } });

  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
    server.seed(FEED, { transactions: [], nextCursor: null });
  });

  it('drives the list from the uncategorized feed, not the plain feed', async () => {
    server.seed(FEED, { transactions: [tx('plain1')], nextCursor: null });
    server.seed(UNCATEGORIZED_FEED, { transactions: [tx('u1'), tx('u2')], nextCursor: null });
    const { result } = renderHook(() => useTransactionsScreenData('uncategorized'), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.transactions.length).toBe(2));
    expect(ids(result.current.transactions)).toEqual(['u1', 'u2']); // uncategorized feed, not 'plain1'
    expect(uncategorizedReads().length).toBeGreaterThan(0);
  });

  it('Load More pages the uncategorized feed via its OWN cursor', async () => {
    server.once('GET', UNCATEGORIZED_FEED, page([tx('u1')], 'ucur1'));
    server.once('GET', UNCATEGORIZED_FEED, page([tx('u2')], null));
    const { result } = renderHook(() => useTransactionsScreenData('uncategorized'), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(result.current.hasMore).toBe(true);
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(2));
    expect(ids(result.current.transactions)).toEqual(['u1', 'u2']);
    expect(result.current.hasMore).toBe(false);
    expect(uncategorizedReads()[1]?.path).toBe('/transactions/uncategorized/feed?cursor=ucur1'); // page 2 fetched with page 1's uncat cursor
  });

  it('a SPARSE first page (0 rows) with a non-null cursor still offers Load More — deep rows reachable', async () => {
    // The crux of the paged design: the server can return an empty page mid-history while more
    // uncategorized rows sit deeper. hasMore keys off the cursor, not the row count, so Load More stays.
    server.once('GET', UNCATEGORIZED_FEED, page([], 'ucur1'));
    server.once('GET', UNCATEGORIZED_FEED, page([tx('deep')], null));
    const { result } = renderHook(() => useTransactionsScreenData('uncategorized'), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.transactions.length).toBe(0); // sparse first page
    expect(result.current.hasMore).toBe(true);           // but MORE history behind it
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['deep'])); // reached the deep row
    expect(result.current.hasMore).toBe(false);
  });

  it('shows the spinner while the uncategorized walk runs (isLoading swaps to the uncat source)', async () => {
    // Feed + categories resolved, uncat feed still pending → isLoading stays true, so switching to the
    // tab shows a spinner instead of a false-empty list. (Without the source swap, isLoading would read
    // the already-loaded plain feed and be false.)
    const heldUncategorized = server.hold(UNCATEGORIZED_FEED);
    server.once('GET', UNCATEGORIZED_FEED, page([tx('u1')], null));
    const { result } = renderHook(() => useTransactionsScreenData('uncategorized'), { wrapper: wrapper(makeClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(true));
    await act(async () => { heldUncategorized.release(); });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('surfaces an uncategorized-feed error as isError on that tab', async () => {
    server.fail(UNCATEGORIZED_FEED, 500);
    const { result } = renderHook(() => useTransactionsScreenData('uncategorized'), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ===== WHIT-190a (folded from transactionsQuery.screen.test.tsx) =====
// The Transactions list on the real query layer: rows come from the auth-gated ['transactions']
// query (not fetched before login), a transient 5xx self-heals, a sustained failure shows an
// inline Retry, cache-first on revisit. Real ../api; ../auth + expo-router mocked; ../context
// PARTIALLY mocked (all above, at module scope); the screen renders under a real
// QueryClientProvider.
describe('the Transactions list on the real query layer (WHIT-190a)', () => {
  function renderTransactions(client = makeClient()) {
    return render(React.createElement(QueryClientProvider, { client }, React.createElement(Transactions)));
  }

  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
    server.seed(FEED, { transactions: TXNS, nextCursor: null });
    server.seed('/categories', mockCategories);
  });

  it('renders transaction rows from the query', async () => {
    renderTransactions();
    expect(await screen.findByText('-$42.00')).toBeTruthy(); // the query-fed row rendered
    expect(feedReads()).toHaveLength(1);
    expect(categoryReads()).toHaveLength(1);
  });

  it('shows a spinner first, then the rows (cache-first)', async () => {
    renderTransactions();
    expect(screen.getByTestId('transactions-loading')).toBeTruthy();
    expect(await screen.findByText('-$42.00')).toBeTruthy();
  });

  it('a transient 5xx retries and self-heals — no error shown', async () => {
    server.once('GET', FEED, { status: 503 });
    renderTransactions(makeClient({ retry: 2 }));
    expect(await screen.findByText('-$42.00')).toBeTruthy();
    expect(screen.queryByTestId('transactions-error')).toBeNull();
    expect(feedReads()).toHaveLength(2);
  });

  it('a sustained failure shows the inline error, and Retry recovers', async () => {
    server.fail(FEED, 503);
    renderTransactions(makeClient());
    expect(await screen.findByTestId('transactions-error')).toBeTruthy();

    // WHIT-198 GAP (authored by qa) — the retry now routes through the shared RetryButton, so it
    // must carry the button role + a screen-reader label a bare Pressable lacked. Locks this
    // migrated screen the way budgetsQuery locks Budgets, so a revert to `<Pressable>` is caught.
    const retry = screen.getByTestId('transactions-retry');
    expect(retry.props.accessibilityRole).toBe('button');
    expect(retry.props.accessibilityLabel).toBe('Retry loading your transactions');

    server.once('GET', FEED, { body: { transactions: TXNS, nextCursor: null } }); // ahead of the failure
    fireEvent.press(retry);
    expect(await screen.findByText('-$42.00')).toBeTruthy();
  });

  it('a sustained feed failure sends a bounded number of requests, and Retry recovers (WHIT-668)', async () => {
    server.fail(FEED, 503);
    renderTransactions(makeClient());
    expect(await screen.findByTestId('transactions-error')).toBeTruthy();
    await pause(200);
    expect(feedReads()).toHaveLength(1);

    server.once('GET', FEED, { body: { transactions: TXNS, nextCursor: null } }); // ahead of the failure
    fireEvent.press(screen.getByTestId('transactions-retry'));
    expect(await screen.findByText('-$42.00')).toBeTruthy();
  });

  it('does not fetch before login, then fires on auth flip to authed', async () => {
    mockAuthStatus = 'anon';
    renderTransactions();
    expect(feedReads()).toHaveLength(0);

    await act(async () => {
      setAuth('authed');
    });
    expect(await screen.findByText('-$42.00')).toBeTruthy();
    expect(feedReads().length).toBeGreaterThan(0);
  });

  it('the inline Retry re-reads the stored account balances (not just the rows)', async () => {
    // Retry (transactions.tsx onPress={refetch}) recovers from a sustained load error by refreshing
    // the rows AND re-reading the stored balances — a cheap GET, no paid live bank call (that's
    // pull-only). Guards that the Retry path keeps its balance refresh.
    server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]);
    server.fail(FEED, 503);
    renderTransactions(makeClient());
    expect(await screen.findByTestId('transactions-error')).toBeTruthy();
    await waitFor(() => expect(balanceReads()).toHaveLength(1)); // fetched once on mount

    server.once('GET', FEED, { body: { transactions: TXNS, nextCursor: null } }); // ahead of the failure
    fireEvent.press(screen.getByTestId('transactions-retry'));
    expect(await screen.findByText('-$42.00')).toBeTruthy();                        // rows recovered
    await waitFor(() => expect(balanceReads()).toHaveLength(2)); // Retry forced balances too
  });

  it('a FAILED live pull toasts, keeps the last-good balances, and clears the spinner (WHIT-363)', async () => {
    // The pull's live refresh rejects. The screen must: toast, keep the list (no error, rows stay),
    // and STILL clear the pull spinner via .finally() — a failed/slow live call can never wedge it.
    server.seed(BALANCES, [{ account_id: 'a1', amount: -100 }]);
    server.fail(REFRESH, 502);
    renderTransactions();
    expect(await screen.findByText('-$42.00')).toBeTruthy(); // rows loaded

    const refreshControl = screen.UNSAFE_getByType(RefreshControl);
    await act(async () => { refreshControl.props.onRefresh(); });

    await waitFor(() => expect(liveRefreshes()).toHaveLength(1)); // the live call fired
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith('Could not refresh balances. Showing last saved.'));
    expect(screen.queryByTestId('transactions-error')).toBeNull(); // list not blanked
    expect(screen.getByText('-$42.00')).toBeTruthy();              // rows still there
    // The spinner cleared once the pull settled, even though the live call rejected.
    await waitFor(() => expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false));
  });
});

// WHIT-614: the transaction detail screen's own composite. It must NOT set up the search query
// (the tab composite always does, which looped the resolver on the detail screen), and its
// spinner/error/Retry must mirror the feed + taxonomy exactly as before.
describe('useTransactionDetailScreenData (WHIT-614)', () => {
  beforeEach(() => {
    mockAuthStatus = 'authed';
    mockAuthListeners.clear();
    server.seed(FEED, { transactions: TXNS, nextCursor: null });
    server.seed('/categories', mockCategories);
  });

  it('never creates a search query in the cache', async () => {
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionDetailScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(client.getQueryCache().findAll({ queryKey: transactionsSearchKey })).toHaveLength(0);
  });

  it('loads the feed + taxonomy: not loading, no error, categories resolve', async () => {
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionDetailScreenData(), { wrapper: wrapper(client) });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isError).toBe(false);
    expect(result.current.category('groceries')?.name).toBe('Groceries');
    expect(result.current.category(null)).toBeUndefined();
  });

  it('isError surfaces when the categories read fails', async () => {
    server.fail('/categories', 500);
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionDetailScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('isError surfaces when the feed read fails', async () => {
    server.fail(FEED, 500);
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionDetailScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('refetch (Retry) re-runs the feed and categories fetches', async () => {
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionDetailScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(feedReads()).toHaveLength(1);
    expect(categoryReads()).toHaveLength(1);

    await act(async () => { result.current.refetch(); });
    await waitFor(() => expect(feedReads()).toHaveLength(2));
    expect(categoryReads()).toHaveLength(2);
  });
});
