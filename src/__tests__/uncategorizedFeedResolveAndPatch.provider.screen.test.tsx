// The paged Uncategorized tab reads its OWN ['uncategorizedFeed'] cache. A deep-history unfiled
// charge shown there lives ONLY in that cache — not in the general feed or the bounded recent
// window. These lock the two things that make such a row usable:
//
//   1. RESOLVE — the write path (readTransactionsCache) must union the uncategorized feed, or
//      tapping a deep row files nothing (applyCategory bails "not found" → no API call). This is
//      the exact regression that would make the feature look broken: the row shows but won't file.
//   2. PATCH + INVALIDATE — filing a row patches its category in the uncategorized feed cache (so
//      the client re-filter drops it from the list instantly) and invalidates the COUNT, but NOT
//      the paged feed itself (invalidating an InfiniteData refetches every loaded page — a storm).
//      Deleting a category is the one path that DOES invalidate the feed: its charges become
//      uncategorized and can't be patched into a cache they aren't in yet.
//
// Fail-on-revert: drop the ['uncategorizedFeed'] arm from readTransactionsCache → test 1 fails;
// drop it from patchTransactionsCache → test 2 fails; drop the deleteCategory feed-invalidate → test 4 fails.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2020-01-01', authorized_date: '2020-01-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

// Seed ONLY the uncategorized feed (a deep-history row present in no other cache).
function seedUncategorizedFeed(transactions: Partial<Transaction>[], nextCursor: string | null = null) {
  queryClient.setQueryData(['uncategorizedFeed'], { pages: [{ transactions, nextCursor }], pageParams: [undefined] });
}
function readUncategorizedFeed(): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>(['uncategorizedFeed']);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}
function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 'deep1', category: 'groceries' });
  mockApi.deleteCategory.mockResolvedValue({ id: 'groceries' });
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
});
afterEach(() => { queryClient.clear(); });

function mount() {
  return renderHook(() => useAppContext(), { wrapper }).result;
}

// [1] RESOLVE — a row only in the uncategorized feed is found and filed. Fail-on-revert: without the
// uncategorized arm in readTransactionsCache, applyCategory bails "not found" and never calls the API.
it('files a deep-history row that lives ONLY in the uncategorized feed cache', async () => {
  seedUncategorizedFeed([txn({ transaction_id: 'deep1' })]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 'deep1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('one'); });

  expect(mockApi.setTransactionCategory).toHaveBeenCalledWith('deep1', 'groceries'); // resolved + persisted
});

// [2] PATCH — filing the row updates its category IN the uncategorized feed cache, so the tab's
// client re-filter drops it from the list immediately (no whole-history re-scan). Fail-on-revert:
// without the uncategorized arm in patchTransactionsCache, the cached row stays category=null.
it('optimistically patches the filed row inside the uncategorized feed cache', async () => {
  seedUncategorizedFeed([txn({ transaction_id: 'deep1', category: null })]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 'deep1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('one'); });

  const row = readUncategorizedFeed().find((t) => t.transaction_id === 'deep1');
  expect(row?.category).toBe('groceries'); // patched in place → no longer matches the uncategorized re-filter
});

// [3] INVALIDATE contract on a file: the COUNT refetches (badge follows), the paged feed does NOT
// (that would storm every loaded page — the optimistic patch above already removed the row).
it('a file invalidates the count but NOT the paged uncategorized feed', async () => {
  seedUncategorizedFeed([txn({ transaction_id: 'deep1' })]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 'deep1', categoryId: 'groceries' }));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategory('one'); });

  const keys = invalidatedKeys(spy);
  expect(keys).toContain('uncategorizedCount');
  expect(keys).not.toContain('uncategorizedFeed');
  spy.mockRestore();
});

// [4] deleteCategory is the exception: its charges BECOME uncategorized and aren't in the feed cache
// to patch, so the paged feed must be invalidated to pull them in. Fail-on-revert: drop that
// invalidate and the newly-unfiled rows never appear on the tab until a manual refresh.
it('deleteCategory invalidates the paged uncategorized feed (rows enter the list)', async () => {
  queryClient.setQueryData(['transactions'], { pages: [{ transactions: [txn({ category: 'groceries' })], nextCursor: null }], pageParams: [undefined] });
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteCategory('groceries'); });

  const keys = invalidatedKeys(spy);
  expect(keys).toContain('uncategorizedFeed');
  expect(keys).toContain('uncategorizedCount');
  spy.mockRestore();
});
