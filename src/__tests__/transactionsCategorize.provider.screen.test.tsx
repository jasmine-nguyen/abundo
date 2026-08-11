// WHIT-190a/192 — the categorise write's cache write + invalidation (the WHIT-193 closure).
// Drives the REAL applyCategory through AppProvider (../api + ../auth mocked) and asserts it
// updates the singleton ['transactions'] feed cache, rolls it back on failure, and invalidates
// ['budgets']/['breakdown'] so the migrated Budgets/Insights screens refresh. The feed itself
// is NOT invalidated (the optimistic patch already wrote it; an InfiniteData invalidate would
// storm every loaded page) — the tests assert that too. (Pre-192 it also wrote an old store.)
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache, seedTransactionsPages, type FeedPage } from './support/transactionsCache';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const DINING = { id: 'dining', name: 'Dining', bucket: 'Lifestyle', icon: 'utensils', color: '#f7768e', recent: 0 } as const;
const txn = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const cachedCategory = (id: string) => readTransactionsCache(queryClient).find((t) => t.transaction_id === id)?.category;

beforeEach(() => {
  queryClient.clear();
  mockApi.createEnrichment.mockResolvedValue({ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
});

// The singleton queryClient's gcTime schedules a timer for inactive cached data;
// clear after each test so no timer leaks past the suite (worker-exit warning).
afterEach(() => {
  queryClient.clear();
});

// WHIT-192: seed the ['transactions'] + ['categories'] caches applyCategory reads (the
// provider no longer eager-loads), then mount.
function mount(transactions: Transaction[] = [txn('t1'), txn('t2')]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  // ['budgets', cycleLen] caches the RAW Record<categoryId, BudgetRollup> (select maps it).
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('applyCategory(one) writes the tx cache AND invalidates budgets/breakdown but NOT the feed', async () => {
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('one'); });

  expect(cachedCategory('t1')).toBe('groceries'); // query cache write
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(['budgets', 'breakdown'])); // WHIT-193 closure
  expect(invalidatedKeys).not.toContain('transactions'); // the feed is patched, never invalidated (no page storm)
  invalidateSpy.mockRestore();
});

it('applyCategory(one) rolls the cache back on failure', async () => {
  mockApi.setTransactionCategory.mockRejectedValue(new Error('boom'));
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('one'); });

  expect(cachedCategory('t1')).toBeNull(); // query cache reverted
});

it('applyCategory(all) writes every same-merchant charge into the cache + invalidates', async () => {
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t2')).toBe('groceries'); // the whole same-merchant sweep hit the cache
  const invalidatedKeys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(invalidatedKeys).toEqual(expect.arrayContaining(['budgets', 'breakdown']));
  expect(invalidatedKeys).not.toContain('transactions'); // feed patched, not invalidated
  invalidateSpy.mockRestore();
});

it('applyCategory(all) rolls back ONLY the failed ids in the cache (partial)', async () => {
  // t2's save comes back not-updated → only t2 reverts; t1 stays categorised.
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] });
  const result = mount();

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries'); // saved → stays
  expect(cachedCategory('t2')).toBeNull(); // not saved → reverted (partial rollback)
});

// WHIT-324: the confirm's "All from this merchant" is now reachable from the detail screen too,
// where the tapped charge can already be categorised. The sweep filters to UNCATEGORISED
// same-merchant charges, so the tapped charge must be force-included or its category never
// changes.
it('applyCategory(all) re-files the tapped charge even when it is already categorised', async () => {
  // t1 already sits under Dining; t2 is uncategorised. Re-filing "all" as Groceries must move
  // BOTH — the tapped t1 (which the sweep filter would otherwise skip) and the swept t2.
  const result = mount([{ ...txn('t1'), category: 'dining' }, txn('t2')]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('groceries'); // tapped charge re-filed despite prior category
  expect(cachedCategory('t2')).toBe('groceries'); // swept in as before
});

it('applyCategory(all) reverts a failed tapped charge to its PREVIOUS category (not null)', async () => {
  mockApi.setTransactionCategories.mockResolvedValue({ results: [] }); // every id fails to save
  const result = mount([{ ...txn('t1'), category: 'dining' }]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(cachedCategory('t1')).toBe('dining'); // failed re-file → back to its real prior category
});

// --- WHIT-355: the "apply to all" tap must not mint a duplicate/clashing rule ---------------

const existingRule = (categoryId: string) => [{ id: 'existing', pattern: 'COLES', categoryId, isNew: false }];

it('[WHIT-355] applyCategory(all) does NOT create a second rule when an identical one exists (duplicate), but still files charges', async () => {
  const result = mount();
  queryClient.setQueryData(['rules'], existingRule('groceries')); // same pattern + same category

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createEnrichment).not.toHaveBeenCalled(); // no duplicate rule minted
  expect(cachedCategory('t1')).toBe('groceries'); // charges still filed
  expect(cachedCategory('t2')).toBe('groceries');
});

it('[WHIT-355] applyCategory(all) neither creates nor changes a rule on a clash, and leaves the existing rule alone', async () => {
  const result = mount();
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);
  queryClient.setQueryData(['rules'], existingRule('dining')); // same pattern, DIFFERENT category

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createEnrichment).not.toHaveBeenCalled();  // no second, fighting rule
  expect(mockApi.updateEnrichment).not.toHaveBeenCalled();  // existing rule never silently changed
  expect((queryClient.getQueryData(['rules']) as { categoryId: string }[])[0].categoryId).toBe('dining'); // untouched
  expect(cachedCategory('t1')).toBe('groceries'); // the tapped charges still file where the user chose
  expect(cachedCategory('t2')).toBe('groceries');
});

it('[WHIT-355] applyCategory(all) STILL creates a rule when no same-pattern rule exists (happy path preserved)', async () => {
  const result = mount();
  queryClient.setQueryData(['rules'], [{ id: 'other', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }]); // unrelated

  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  await act(async () => { await result.current.applyCategory('all'); });

  expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'COLES', categoryId: 'groceries' });
});

// --- WHIT-291: applyCategoryToMany (multi-select batch re-file) ------------------------------

it('applyCategoryToMany re-files exactly the ids in the set, in one batch, + invalidates', async () => {
  const result = mount([txn('t1'), txn('t2'), txn('t3')]);
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't3'], 'groceries'); });

  expect(cachedCategory('t1')).toBe('groceries');
  expect(cachedCategory('t3')).toBe('groceries');
  expect(cachedCategory('t2')).toBeNull(); // not in the set → untouched
  const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toEqual(expect.arrayContaining(['budgets', 'breakdown']));
  expect(keys).not.toContain('transactions'); // feed patched, not invalidated
  invalidateSpy.mockRestore();
});

it('applyCategoryToMany reverts only the FAILED ids to their previous category (partial)', async () => {
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] }); // t2 not saved
  const result = mount([{ ...txn('t1'), category: 'dining' }, { ...txn('t2'), category: 'dining' }]);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(cachedCategory('t1')).toBe('groceries'); // saved → stays
  expect(cachedCategory('t2')).toBe('dining');    // failed → back to its PREVIOUS category, not null
});

it('applyCategoryToMany drops ids not in the cache and never calls the batch on an empty set', async () => {
  const result = mount([txn('t1')]);
  await act(async () => { await result.current.applyCategoryToMany(['ghost'], 'groceries'); });
  expect(mockApi.setTransactionCategories).not.toHaveBeenCalled(); // nothing real to file
});

// ===== WHIT-190a/192 (folded from transactionsFeedOptimistic.provider.screen.test.tsx) =====
// The feed's InfiniteData cache under optimistic writes — proves a row on a PAGED-IN (page 2)
// batch updates IN PLACE across pages, and the page/cursor structure survives (the write path
// maps its row transform per page; no add/remove). Without the InfiniteData-aware patch/read the
// paged-in row would never update. Drives the REAL applyTransactionEdit + applyCategoryToMany
// through AppProvider (../api + ../auth mocked — same regime as above, at module scope).
describe('the feed InfiniteData cache under optimistic writes', () => {
  const pages = (): FeedPage[] =>
    (queryClient.getQueryData(['transactions']) as { pages: FeedPage[] }).pages;
  const recentRows = (): Transaction[] => queryClient.getQueryData<Transaction[]>(['transactionsRecent']) ?? [];

  beforeEach(() => {
    queryClient.clear();
    mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => ({
      results: updates.map((u) => ({ id: u.id, status: 'updated' as const })),
    }));
  });

  it('applyTransactionEdit updates a PAGE 2 row in place, preserving page boundaries + cursors', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'p2', notes: 'hi' });
    seedTransactionsPages(queryClient, [
      { transactions: [txn('p1a'), txn('p1b')], nextCursor: 'cur1' },
      { transactions: [txn('p2')], nextCursor: null },
    ]);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('p2', { notes: 'hi' }); });

    const p = pages();
    expect(p.length).toBe(2); // structure preserved (not collapsed to one page)
    expect(p[0].transactions.map((t) => t.transaction_id)).toEqual(['p1a', 'p1b']); // page 1 untouched
    expect(p[0].nextCursor).toBe('cur1'); // page 1 cursor intact
    expect(p[1].transactions[0].notes).toBe('hi'); // page 2 row updated in place
    expect(p[1].nextCursor).toBeNull();
  });

  it('applyCategoryToMany re-files a PAGE 2 row across pages without disturbing page 1', async () => {
    seedTransactionsPages(queryClient, [
      { transactions: [txn('p1')], nextCursor: 'cur1' },
      { transactions: [txn('p2')], nextCursor: null },
    ]);
    queryClient.setQueryData(['categories'], [{ ...CAT }]);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyCategoryToMany(['p2'], 'groceries'); });

    const p = pages();
    expect(p.length).toBe(2);
    expect(p[1].transactions[0].category).toBe('groceries'); // paged-in row re-filed
    expect(p[0].transactions[0].category).toBeNull(); // page 1 untouched
  });

  // The feed and the bounded ['transactionsRecent'] cache overlap on the newest rows. An edit must
  // patch BOTH, or the tab-bar dot / account-detail / goal-edit (which read recent) keep stale data.
  it('an edit on an OVERLAP charge patches the recent cache too, not just the feed', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'p1', notes: 'x' });
    seedTransactionsPages(queryClient, [{ transactions: [txn('p1')], nextCursor: null }]);
    queryClient.setQueryData(['transactionsRecent'], [txn('p1')]); // same charge sits in both caches
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('p1', { notes: 'x' }); });

    expect(pages()[0].transactions[0].notes).toBe('x'); // feed updated
    expect(recentRows()[0].notes).toBe('x'); // recent updated too → dot/account-detail stay live
  });

  // A charge within the recent window but BEYOND the feed's loaded pages is recent-only. The write
  // must still fire — a feed-only lookup would leave `transaction` undefined and silently no-op.
  // FAIL-ON-REVERT: narrow readTransactionsCache back to the feed and setTransactionFields is never
  // called here.
  it('a write on a RECENT-ONLY charge (beyond the feed) actually fires and files it', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'r1', notes: 'x' });
    seedTransactionsPages(queryClient, [{ transactions: [txn('feedOnly')], nextCursor: 'cur1' }]); // feed lacks r1
    queryClient.setQueryData(['transactionsRecent'], [txn('r1')]); // r1 lives ONLY in the recent cache
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('r1', { notes: 'x' }); });

    expect(mockApi.setTransactionFields).toHaveBeenCalledWith('r1', { notes: 'x' }); // NOT a silent no-op
    expect(recentRows()[0].notes).toBe('x'); // filed into the recent cache
  });
});
