// WHIT-500/501 gaps — the query-layer wiring for the paged Uncategorized tab.
// These do NOT duplicate transactionsScreenData.screen.test.tsx (which drives ONE tab per mount)
// nor uncategorizedFeedResolveAndPatch.provider.screen.test.tsx (which locks context.tsx's
// readTransactionsCache/patchTransactionsCache). The gaps here:
//   [C1] tab-switch lifecycle across ONE mount: all -> uncategorized -> all keeps the plain feed
//        intact and re-fetches neither feed on the way back.
//   [C2] useTransactionResolver (queries.ts) — a SEPARATE union impl from context.tsx, mocked out
//        in every screen suite, so its real behaviour is untested: it must find a row that lives
//        ONLY in the uncategorized feed cache AND de-dupe a row present in both feeds. The resolver
//        reads the uncategorized feed PASSIVELY (enabled: false — the tab warms it), so this seeds
//        that cache directly rather than driving a fetch.
//   [C3] refetchList is keyed to the ACTIVE feed: a pull on 'all' must not trim/refetch the
//        uncategorized feed cache, and vice-versa.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transaction } from '../context';

let mockAuthStatus = 'authed';
jest.mock('../auth', () => ({ getStatus: () => mockAuthStatus, subscribe: () => () => {} }));

const mockFeed = jest.fn<(cursor?: string) => Promise<unknown>>();
const mockUncat = jest.fn<(cursor?: string) => Promise<unknown>>();
const mockRecent = jest.fn<() => Promise<unknown>>();
const mockCategories = jest.fn<() => Promise<unknown>>();
const mockBalances = jest.fn<() => Promise<unknown>>();
jest.mock('../api', () => ({
  fetchTransactionsFeed: (cursor?: string) => mockFeed(cursor),
  fetchUncategorizedFeed: (cursor?: string) => mockUncat(cursor),
  fetchTransactions: () => mockRecent(),
  fetchCategories: () => mockCategories(),
  fetchAccountBalances: () => mockBalances(),
}));

import { useTransactionsScreenData, useTransactionResolver, transactionsKey, uncategorizedFeedKey } from '../queries';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
});
const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
const wrapper = (client: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client }, children);

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFeed.mockReset();
  mockUncat.mockReset();
  mockRecent.mockReset().mockResolvedValue([]);
  mockCategories.mockReset().mockResolvedValue([]);
  mockBalances.mockReset().mockResolvedValue([]);
});

// [C1] tab-switch lifecycle — one mount, tab arg changes. Switching back to 'all' must keep the
// plain feed's rows and NOT re-fetch either feed (both queries are cached; the uncat one just
// stops being enabled). Fail-on-revert: if 'all' read the uncategorized source, the back-switch
// would show u-rows, not plain1.
describe('[C1] tab-switch lifecycle (all -> uncategorized -> all)', () => {
  it('keeps the plain feed on the way back and re-fetches neither feed', async () => {
    mockFeed.mockResolvedValue({ transactions: [tx('plain1')], nextCursor: null });
    mockUncat.mockResolvedValue({ transactions: [tx('u1')], nextCursor: null });
    const { result, rerender } = renderHook((tab: 'all' | 'uncategorized') => useTransactionsScreenData(tab), {
      wrapper: wrapper(makeClient()), initialProps: 'all' as 'all' | 'uncategorized',
    });

    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['plain1']));
    expect(mockUncat).not.toHaveBeenCalled();       // uncategorized query only FETCHES on its tab
    expect(mockFeed).toHaveBeenCalledTimes(1);

    rerender('uncategorized');
    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['u1']));
    expect(mockUncat).toHaveBeenCalledTimes(1);

    rerender('all');
    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['plain1'])); // plain feed intact
    expect(mockFeed).toHaveBeenCalledTimes(1);       // NOT re-fetched
    expect(mockUncat).toHaveBeenCalledTimes(1);       // NOT re-fetched
  });
});

// [C2] useTransactionResolver union — the real impl (mocked out in every screen suite). It reads the
// uncategorized feed PASSIVELY (the Uncategorized tab warms it), so seed that cache directly; the
// plain feed and recent are fetched as normal.
describe('[C2] useTransactionResolver unions the uncategorized feed', () => {
  it('finds a row that lives ONLY in the uncategorized feed and de-dupes a row in both', async () => {
    mockFeed.mockResolvedValue({ transactions: [tx('dup', { description: 'FEED' }), tx('feedonly')], nextCursor: null });
    mockRecent.mockResolvedValue([tx('recentonly')]);
    const client = makeClient();
    // The uncategorized feed cache the tab would have warmed (dup is ALSO in the plain feed).
    client.setQueryData(uncategorizedFeedKey, {
      pages: [{ transactions: [tx('dup', { description: 'UNCAT' }), tx('deep')], nextCursor: null }],
      pageParams: [undefined],
    });
    const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.findTx('feedonly')).toBeDefined()); // feed loaded
    expect(result.current.findTx('deep')!.transaction_id).toBe('deep');           // uncat-feed-only, resolved
    // de-dupe: 'dup' is in both feeds but appears exactly once, and the FEED copy wins (added first).
    expect(ids(result.current.transactions).filter((id) => id === 'dup')).toHaveLength(1);
    expect(result.current.findTx('dup')!.description).toBe('FEED');
    // the whole union is present, each once.
    expect(new Set(ids(result.current.transactions))).toEqual(new Set(['dup', 'feedonly', 'deep', 'recentonly']));
  });
});

// [C3] refetchList is keyed to the ACTIVE feed only.
describe('[C3] refetchList touches only the active feed cache', () => {
  it('a pull on the ALL tab leaves the uncategorized feed cache untrimmed', async () => {
    mockFeed.mockResolvedValue({ transactions: [tx('plain1')], nextCursor: null });
    const client = makeClient();
    // Seed a 2-page uncategorized feed cache as if the user had paged it earlier.
    client.setQueryData(uncategorizedFeedKey, {
      pages: [{ transactions: [tx('u1')], nextCursor: 'c1' }, { transactions: [tx('u2')], nextCursor: null }],
      pageParams: [undefined, 'c1'],
    });
    const { result } = renderHook(() => useTransactionsScreenData('all'), { wrapper: wrapper(client) });
    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['plain1']));

    await act(async () => { result.current.refetchList(); });

    const uncat = client.getQueryData<{ pages: { transactions: Transaction[] }[] }>(uncategorizedFeedKey);
    expect(uncat!.pages).toHaveLength(2);            // uncategorized feed NOT trimmed by an 'all' pull
    expect(mockUncat).not.toHaveBeenCalled();        // NOR refetched
  });

  it('a pull on the UNCATEGORIZED tab trims the uncategorized feed, not the plain feed', async () => {
    mockUncat
      .mockResolvedValueOnce({ transactions: [tx('u1')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ transactions: [tx('u2')], nextCursor: null })
      .mockResolvedValue({ transactions: [tx('u1')], nextCursor: 'c1' }); // pull -> page 1 fresh
    const client = makeClient();
    // Seed a 2-page plain feed cache; it must survive an uncategorized pull.
    client.setQueryData(transactionsKey, {
      pages: [{ transactions: [tx('p1')], nextCursor: 'pc1' }, { transactions: [tx('p2')], nextCursor: null }],
      pageParams: [undefined, 'pc1'],
    });
    const { result } = renderHook(() => useTransactionsScreenData('uncategorized'), { wrapper: wrapper(client) });
    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['u1']));
    await act(async () => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.transactions.length).toBe(2)); // 2 uncat pages loaded

    await act(async () => { result.current.refetchList(); });                 // pull on the uncat tab

    await waitFor(() => expect(ids(result.current.transactions)).toEqual(['u1'])); // uncat trimmed to newest
    const plain = client.getQueryData<{ pages: unknown[] }>(transactionsKey);
    expect(plain!.pages).toHaveLength(2);            // plain feed cache untouched
  });
});
