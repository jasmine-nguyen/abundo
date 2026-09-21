// Transaction-detail resolver fix — ADVERSARIAL resolver gaps for useTransactionResolver
// (src/queries.ts). Does NOT duplicate uncategorizedFeedQueries.screen.test.tsx's [C4] block
// (budget-only resolve, category-only resolve, feed-wins de-dup, budget-cache reactivity, narrow
// subscription, cold not-found). The gaps here:
//   [R1] a charge present in BOTH a budget cache AND a category cache de-dupes to ONE row.
//   [R2] a charge present in TWO budget caches (parent + child subtree lists) merges to ONE row.
//   [R3] reactivity when a CATEGORY cache (not budget) changes after mount — the twin of [C4]'s
//        budget-cache reactivity, guarding the categoryTransactionsKey[0] arm of the subscription.
//   [R4] a category cache whose data is undefined/empty contributes NO phantom and never throws.
//   [R5] correctness holds across MANY scoped caches (the findTx scan spans them all).
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

import { useTransactionResolver, budgetTransactionsKey, categoryTransactionsKey, transactionsKey, transactionsRecentKey } from '../queries';

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
});
const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, gcTime: Infinity } } });
const wrapper = (client: QueryClient) => ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client }, children);
const emptyFeed = () => mockFeed.mockResolvedValue({ transactions: [], nextCursor: null });

beforeEach(() => {
  mockAuthStatus = 'authed';
  mockFeed.mockReset();
  mockUncat.mockReset();
  mockRecent.mockReset().mockResolvedValue([]);
  mockCategories.mockReset().mockResolvedValue([]);
  mockBalances.mockReset().mockResolvedValue([]);
});

describe('[R] useTransactionResolver — cross-scoped-cache merge edges', () => {
  // [R1] The SAME charge sits in a budget-detail cache AND an Insights category-drill cache (both
  // scoped). The de-dup seen-set must collapse them to ONE row. queries.ts adds budget caches
  // BEFORE category caches, so — with the feed empty — the budget copy wins the de-dup.
  // FAIL-ON-REVERT: reverting queries.ts drops both scoped loops → 'bill' resolves to nothing.
  it('[R1] a charge in BOTH a budget cache and a category cache de-dupes to one (budget copy wins)', async () => {
    emptyFeed();
    const client = makeClient();
    client.setQueryData([...budgetTransactionsKey, 'insurance'], [tx('bill', { description: 'BUDGET' })]);
    client.setQueryData([...categoryTransactionsKey, 'insurance', 0], [tx('bill', { description: 'CATEGORY' })]);
    const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.findTx('bill')).toBeDefined());
    expect(ids(result.current.transactions).filter((id) => id === 'bill')).toHaveLength(1); // exactly one
    expect(result.current.findTx('bill')!.description).toBe('BUDGET'); // budget scanned before category
  });

  // [R2] A leaf charge is listed under BOTH a budgeted parent and its child subtree list (two
  // ['budgetTransactions', *] caches). The union must still show it exactly once.
  // FAIL-ON-REVERT: reverting queries.ts drops the budget loop → 'cafe' resolves to nothing.
  it('[R2] a charge in two budget caches (parent + child subtree) merges to one row', async () => {
    emptyFeed();
    const client = makeClient();
    client.setQueryData([...budgetTransactionsKey, 'food'], [tx('cafe', { description: 'PARENT' })]);
    client.setQueryData([...budgetTransactionsKey, 'coffee'], [tx('cafe', { description: 'CHILD' })]);
    const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.findTx('cafe')).toBeDefined());
    expect(ids(result.current.transactions).filter((id) => id === 'cafe')).toHaveLength(1); // one merged row
  });

  // [R3] The twin of [C4]'s budget reactivity, but ISOLATED to the category arm: an optimistic edit
  // to a CATEGORY-drill cache after mount must re-run the merge. Feed + recent are pre-seeded as
  // already-fresh (staleTime 60s) so NEITHER fetches — that removes the pending feed/recent renders
  // that would otherwise recompute the memo anyway, leaving the category setQueryData as the ONLY
  // possible trigger. FAIL-ON-REVERT (targeted): dropping `|| key === categoryTransactionsKey[0]`
  // from the subscription leaves the initial resolve intact but freezes this post-mount change.
  it('[R3] reacts ONLY via the subscription when a category-drill cache changes after mount', async () => {
    const client = makeClient();
    client.setQueryData(transactionsKey, { pages: [{ transactions: [], nextCursor: null }], pageParams: [undefined] });
    client.setQueryData(transactionsRecentKey, []);
    const drillKey = [...categoryTransactionsKey, 'coffee', 0];
    client.setQueryData(drillKey, [tx('past', { notes: '' })]);
    const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.findTx('past')).toBeDefined());
    act(() => { client.setQueryData(drillKey, [tx('past', { notes: 'seen' })]); });
    await waitFor(() => expect(result.current.findTx('past')!.notes).toBe('seen'));
  });

  // [R4] A registered-but-unresolved category query (data === undefined) and an EMPTY category cache
  // must be ignored by the `rows ?? EMPTY_TX` guard — no throw, no phantom entry — while a real
  // budget row still resolves. FAIL-ON-REVERT: reverting queries.ts drops the budget loop → 'bill'
  // resolves to nothing (the union-length guard also catches a phantom the guard would let slip).
  it('[R4] ignores an undefined/empty category cache (no phantom, no throw)', async () => {
    emptyFeed();
    const client = makeClient();
    client.setQueryData([...budgetTransactionsKey, 'insurance'], [tx('bill')]);
    client.setQueryData([...categoryTransactionsKey, 'empty', 0], []); // present but empty
    client.getQueryCache().build(client, { queryKey: [...categoryTransactionsKey, 'pending', 1] }); // data === undefined
    const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.findTx('bill')).toBeDefined());
    expect(ids(result.current.transactions)).toEqual(['bill']); // exactly the real row, nothing phantom
  });

  // [R5] Correctness across MANY scoped caches — the findTx scan spans every ['budgetTransactions',*]
  // and ['categoryTransactions',*] entry, so a target buried among dozens still resolves exactly once.
  // (P2 — a scale smoke test, not a timing assertion.) FAIL-ON-REVERT: reverting queries.ts → not found.
  it('[R5] resolves a target buried among many scoped caches, exactly once', async () => {
    emptyFeed();
    const client = makeClient();
    for (let i = 0; i < 40; i++) client.setQueryData([...budgetTransactionsKey, `b${i}`], [tx(`bx${i}`)]);
    for (let i = 0; i < 40; i++) client.setQueryData([...categoryTransactionsKey, `c${i}`, 0], [tx(`cx${i}`)]);
    client.setQueryData([...budgetTransactionsKey, 'needle'], [tx('target', { description: 'FOUND' })]);
    const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.findTx('target')).toBeDefined());
    expect(result.current.findTx('target')!.description).toBe('FOUND');
    expect(ids(result.current.transactions).filter((id) => id === 'target')).toHaveLength(1);
  });
});
