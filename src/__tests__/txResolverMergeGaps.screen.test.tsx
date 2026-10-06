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
//   [R6] WHIT-614: a switched-off search query mounted beside the resolver (the detail screen's old
//        shape) doesn't loop — watcher events never move the version, only data changes do.
//   [R7] WHIT-614: seeding a search, budget or category cache after mount still resolves the row.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { makeClient, wrapper } from './support/queryClient';
import type { Transaction } from '../types';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct } from './support/renderWithQueries';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';

import { useTransactionResolver, useTransactionsSearchQuery, budgetTransactionsKey, categoryTransactionsKey, transactionsKey, transactionsRecentKey, transactionsSearchKey } from '../queries';

const server = installFakeServer();

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'X', merchant_name: 'X', amount: -1, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
});
const ids = (list: Transaction[]) => list.map((t) => t.transaction_id);
const emptyFeed = () => server.seed('/transactions/feed', { transactions: [], nextCursor: null });

beforeEach(() => {
  resetAuth();
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
    await refreshInAct(() => client.setQueryData(drillKey, [tx('past', { notes: 'seen' })]));
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

  // [R6] Mounting a query on a watched key re-applies its options on every redraw. Counting those
  // watcher events bumped the version → redraw → options re-applied → bump: an endless loop that
  // crashed the detail screen. FAIL-ON-REVERT: dropping the event-type filter loops (render count
  // explodes) and hands back a new `transactions` list on every redraw.
  it('[R6] a switched-off search query beside the resolver never loops or moves the version', async () => {
    const client = makeClient();
    client.setQueryData(transactionsKey, { pages: [{ transactions: [tx('a')], nextCursor: null }], pageParams: [undefined] });
    client.setQueryData(transactionsRecentKey, []);
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders += 1;
      useTransactionsSearchQuery('all', '', false);
      return useTransactionResolver();
    }, { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.findTx('a')).toBeDefined());
    const before = result.current.transactions;
    rerender({});
    rerender({});
    await act(async () => { await Promise.resolve(); });
    expect(result.current.transactions).toBe(before);
    expect(renders).toBeLessThan(10);
  });

  // [R7] The filter keeps real data changes: setQueryData fires 'updated', so a row seeded into any
  // watched cache after mount still resolves. FAIL-ON-REVERT: filtering out 'updated' freezes these.
  it('[R7] seeding a search, budget or category cache after mount still resolves the new row', async () => {
    const client = makeClient();
    client.setQueryData(transactionsKey, { pages: [{ transactions: [], nextCursor: null }], pageParams: [undefined] });
    client.setQueryData(transactionsRecentKey, []);
    const { result } = renderHook(() => useTransactionResolver(), { wrapper: wrapper(client) });
    expect(result.current.transactions).toHaveLength(0);

    await refreshInAct(() => client.setQueryData([...transactionsSearchKey, 'all', 'deep'], { transactions: [tx('searched')], truncated: false }));
    await waitFor(() => expect(result.current.findTx('searched')).toBeDefined());
    await refreshInAct(() => client.setQueryData([...budgetTransactionsKey, 'rent'], [tx('budgeted')]));
    await waitFor(() => expect(result.current.findTx('budgeted')).toBeDefined());
    await refreshInAct(() => client.setQueryData([...categoryTransactionsKey, 'coffee', 0], [tx('drilled')]));
    await waitFor(() => expect(result.current.findTx('drilled')).toBeDefined());
  });
});
