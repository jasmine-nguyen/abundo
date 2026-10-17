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
import { render, renderHook, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeClient, wrapper, pause } from './support/queryClient';
import type { Transaction } from '../types';
import { installFakeServer, seedFeedPage } from './support/fakeServer';

// ../auth — mutable status (superset: supports the screen-render auth-flip test). INERT for the
// renderHook describes: their beforeEach re-seeds 'authed' and no test calls setAuthStatus, so the
// listener Set never fires — behaviourally identical to a static `() => 'authed'` stub.
jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';


const mockCategories = [{ ...GROCERIES_RECORD, color: '#7FD49B' }];

// ../context — PARTIALLY mocked (real selectors, stubbed useAppContext for TransactionRow +
// retryLoad) so ../queries' real imports still resolve; the screen renders under a real
// QueryClientProvider. INERT for the renderHook describes (they never mount a component that
// reads useAppContext; every other export passes through requireActual).
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ retryLoad: jest.fn(), openMultiPicker: jest.fn(), showToast: jest.fn(), category: (id: string | null) => mockCategories.find((c) => c.id === id) })),
);

// expo-router — mocked for the screen render. INERT for the renderHook describes (the composite
// hook does not import expo-router; it returns refetchStale for the screen to wire to focus).
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import {
  useTransactionsScreenData, useRecentTransactionsScreenData, useTransactionDetailScreenData,
  useTransactionsFeedQuery, useUncategorizedFeedQuery,
} from '../queries';
import { accountBalancesKey, transactionsSearchKey } from '../queryKeys';
import Transactions from '../../app/(tabs)/transactions';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();
const FEED = '/transactions/feed';
const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const BALANCES = '/accounts/balances';
const feedReads = () => server.sentUnder('GET', FEED);
const uncategorizedReads = () => server.sentUnder('GET', UNCATEGORIZED_FEED);
const balanceReads = () => server.sent('GET', BALANCES);

const TXNS = [{
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -42, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'purchase', counts_to_budget: true,
}];

describe('useTransactionsScreenData composite (WHIT-190a gaps)', () => {
  beforeEach(() => {
    resetAuth();
    seedFeedPage(server, FEED, TXNS);
    server.seed('/categories', mockCategories);
  });

  it('refetchStale REFETCHES a STALE single-page cache (focus refresh re-checks the newest page)', async () => {
    const client = makeClient({ staleTime: 0 }); // immediately stale
    const { result } = renderHook(() => useTransactionsScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.transactions.length).toBe(1));
    expect(feedReads()).toHaveLength(1);

    await act(async () => { result.current.refetchStale(); });
    await waitFor(() => expect(feedReads()).toHaveLength(2));
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
    resetAuth();
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
    seedFeedPage(server, FEED, [tx('f1')]);
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
    resetAuth();
    seedFeedPage(server, FEED, []);
  });

  it('drives the list from the uncategorized feed, not the plain feed', async () => {
    seedFeedPage(server, FEED, [tx('plain1')]);
    seedFeedPage(server, UNCATEGORIZED_FEED, [tx('u1'), tx('u2')]);
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

  // WHIT-661: each feed's Load More sends the previous page's cursor URL-encoded, on its own path.
  it.each([
    {
      feed: 'the feed', path: FEED, otherPath: UNCATEGORIZED_FEED, useFeed: useTransactionsFeedQuery,
      firstPage: [tx('p1')], cursor: 'a/b+c=', nextPath: '/transactions/feed?cursor=a%2Fb%2Bc%3D', loaded: ['p1', 'p2'],
    },
    {
      feed: 'the Uncategorized feed', path: UNCATEGORIZED_FEED, otherPath: FEED, useFeed: useUncategorizedFeedQuery,
      firstPage: [], cursor: 'deep/cursor+1', nextPath: '/transactions/uncategorized/feed?cursor=deep%2Fcursor%2B1', loaded: ['p2'],
    },
  ])('Load More on $feed sends its cursor URL-encoded, on its own path', async ({ path, otherPath, useFeed, firstPage, cursor, nextPath, loaded }) => {
    server.once('GET', path, page(firstPage, cursor));
    server.once('GET', path, page([tx('p2')], null));
    const { result } = renderHook(() => useFeed(true), { wrapper: wrapper(makeClient()) });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    await act(async () => { await result.current.fetchNextPage(); });

    expect(server.sentUnder('GET', path).map((request) => request.path)).toEqual([path, nextPath]);
    expect(server.sentUnder('GET', otherPath)).toHaveLength(0);
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(result.current.data?.pages.flatMap((feedPage) => ids(feedPage.transactions))).toEqual(loaded);
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
    resetAuth();
    seedFeedPage(server, FEED, TXNS);
    server.seed('/categories', mockCategories);
  });

  it("each date heading shows that day's total (WHIT-847)", async () => {
    renderTransactions();
    expect(await screen.findByText(/ · \$42 spent$/)).toBeTruthy();
  });

  // [A4] a day with nothing that counts shows the bare date, no " · " suffix
  it('a date heading with nothing that counts shows just the date (WHIT-847)', async () => {
    seedFeedPage(server, FEED, [{ ...TXNS[0], amount: 900, category: 'income' }]);
    renderTransactions();
    expect(await screen.findByText('+$900.00')).toBeTruthy();
    expect(screen.getByText('Wed 1 Jul')).toBeTruthy();
  });

  it('a transient 5xx retries and self-heals — no error shown', async () => {
    server.once('GET', FEED, { status: 503 });
    renderTransactions(makeClient({ retry: 2 }));
    expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();
    expect(screen.queryByTestId('transactions-error')).toBeNull();
    expect(feedReads()).toHaveLength(2);
  });

  it('a sustained feed failure sends a bounded number of requests, and Retry recovers (WHIT-668)', async () => {
    server.fail(FEED, 503);
    renderTransactions(makeClient());
    expect(await screen.findByTestId('transactions-error')).toBeTruthy();
    await pause(200);
    expect(feedReads()).toHaveLength(1);

    server.once('GET', FEED, { body: { transactions: TXNS, nextCursor: null } }); // ahead of the failure
    fireEvent.press(screen.getByTestId('transactions-retry'));
    expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();
  });

  it('does not fetch before login, then fires on auth flip to authed', async () => {
    setAuthStatusQuietly('anon');
    renderTransactions();
    expect(feedReads()).toHaveLength(0);

    await act(async () => {
      setAuthStatus('authed');
    });
    expect(await screen.findByText('−\u2060$42.00')).toBeTruthy();
    expect(feedReads().length).toBeGreaterThan(0);
  });
});

// WHIT-614: the transaction detail screen's own composite. It must NOT set up the search query
// (the tab composite always does, which looped the resolver on the detail screen), and its
// spinner/error/Retry must mirror the feed + taxonomy exactly as before.
describe('useTransactionDetailScreenData (WHIT-614)', () => {
  beforeEach(() => {
    resetAuth();
    seedFeedPage(server, FEED, TXNS);
    server.seed('/categories', mockCategories);
  });

  it('never creates a search query in the cache', async () => {
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionDetailScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(client.getQueryCache().findAll({ queryKey: transactionsSearchKey })).toHaveLength(0);
  });

  it('isError surfaces when the feed read fails', async () => {
    server.fail(FEED, 500);
    const client = makeClient({ staleTime: Infinity });
    const { result } = renderHook(() => useTransactionDetailScreenData(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
