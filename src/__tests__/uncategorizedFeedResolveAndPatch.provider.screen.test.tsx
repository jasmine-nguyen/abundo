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
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { GROCERIES } from './support/categories';
import { invalidatedKeys } from './support/queryClient';
import { colesTxn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const CAT = GROCERIES;
const txn = (over: Partial<Transaction> = {}) => colesTxn({ date: '2020-01-01', authorized_date: '2020-01-01', ...over });

// Seed ONLY the uncategorized feed (a deep-history row present in no other cache).
function seedUncategorizedFeed(transactions: Partial<Transaction>[], nextCursor: string | null = null) {
  queryClient.setQueryData(['uncategorizedFeed'], { pages: [{ transactions, nextCursor }], pageParams: [undefined] });
}
function readUncategorizedFeed(): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>(['uncategorizedFeed']);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}
beforeEach(() => {
  queryClient.clear();
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

  expect(server.requests()).toContainEqual({ method: 'PATCH', path: '/transactions/deep1', body: { category: 'groceries' } }); // resolved + persisted
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
