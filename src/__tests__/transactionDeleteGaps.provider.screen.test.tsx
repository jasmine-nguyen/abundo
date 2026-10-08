// WHIT-654 QA — deleteTransaction edges the main suite doesn't reach: the uncategorized feed and
// the recent window, the removal showing BEFORE the server answers, multi-page feeds, a 404 or a
// lost connection, and which caches are (and aren't) refreshed. REAL action through AppProvider.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsPages, readTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper as wrapper } from './support/renderWithApp';
import { anthropicSubTxn } from './factory';

const server = installFakeServer();

const txn = (over: Partial<Transaction> = {}) => anthropicSubTxn({ category: null as unknown as string, ...over });
const KEEP = txn({ transaction_id: 'keep', status: 'posted' });
const OLDER = txn({ transaction_id: 'older', status: 'posted', date: '2026-08-01' });

type Feed = { pages: { transactions: Transaction[]; nextCursor: string | null }[] };

function seed() {
  // The duplicate sits on page 2 of the feed, so the removal must walk every loaded page.
  seedTransactionsPages(queryClient, [
    { transactions: [KEEP], nextCursor: 'c1' },
    { transactions: [txn(), OLDER], nextCursor: null },
  ]);
  queryClient.setQueryData(['uncategorizedFeed'], { pages: [{ transactions: [txn(), KEEP], nextCursor: null }], pageParams: [undefined] });
  queryClient.setQueryData(['transactionsRecent'], [txn(), KEEP]);
}

const ids = (rows: Transaction[] | undefined) => (rows ?? []).map((row) => row.transaction_id);
const uncategorizedIds = () => ids(queryClient.getQueryData<Feed>(['uncategorizedFeed'])?.pages.flatMap((p) => p.transactions));
const recentIds = () => ids(queryClient.getQueryData<Transaction[]>(['transactionsRecent']));

function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

// [B1]
it('drops the charge from the uncategorized feed, the recent window and a deep feed page, keeping page shape', async () => {
  seed();
  const result = mount();
  await act(async () => { await result.current.deleteTransaction('dup'); });

  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep', 'older']);
  expect(queryClient.getQueryData<Feed>(['transactions'])?.pages.map((p) => p.nextCursor)).toEqual(['c1', null]);
  expect(uncategorizedIds()).toEqual(['keep']);
  expect(recentIds()).toEqual(['keep']);
});

// [B2]
it('removes the charge at once, before the server answers', async () => {
  seed();
  const held = server.hold('/transactions/dup');
  const result = mount();

  let pending!: Promise<boolean>;
  act(() => { pending = result.current.deleteTransaction('dup'); });
  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep', 'older']);
  expect(uncategorizedIds()).toEqual(['keep']);
  expect(recentIds()).toEqual(['keep']);

  held.release();
  await act(async () => { await pending; });
  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep', 'older']);
});

// [B3]
it('a 404 (already gone on the server) rolls back every copy and warns', async () => {
  seed();
  server.fail('/transactions/dup', 404);
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteTransaction('dup'); });

  expect(ok).toBe(false);
  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep', 'dup', 'older']);
  expect(uncategorizedIds()).toEqual(['dup', 'keep']);
  expect(recentIds()).toEqual(['dup', 'keep']);
  expect(result.current.toast).toBe('Could not delete. Please try again.');
});

// [B4]
it('a lost connection rolls back and resolves false (never throws)', async () => {
  seed();
  server.once('DELETE', '/transactions/dup', 'dropped');
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteTransaction('dup'); });

  expect(ok).toBe(false);
  expect(recentIds()).toEqual(['dup', 'keep']);
  expect(result.current.toast).toBe('Could not delete. Please try again.');
});

// [B5]
it('success refreshes the totals and the scoped lists, never the paged feeds (no refetch storm)', async () => {
  seed();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const result = mount();
  await act(async () => { await result.current.deleteTransaction('dup'); });

  const refreshed = invalidatedKeys(invalidate);
  expect(refreshed).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'budgetTransactions', 'categoryTransactions', 'uncategorizedCount']));
  expect(refreshed).not.toContain('transactions');
  expect(refreshed).not.toContain('uncategorizedFeed');
  invalidate.mockRestore();
});

// [B6]
it('a failed delete refreshes nothing', async () => {
  seed();
  server.fail('/transactions/dup', 500);
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const result = mount();
  await act(async () => { await result.current.deleteTransaction('dup'); });

  const refreshed = invalidatedKeys(invalidate);
  expect(refreshed).not.toContain('budgets');
  invalidate.mockRestore();
});

// [B7]
it('a rollback after the caches were cleared (signed out mid-delete) does not bring data back', async () => {
  seed();
  server.fail('/transactions/dup', 500);
  const held = server.hold('/transactions/dup');
  const result = mount();

  let pending!: Promise<boolean>;
  act(() => { pending = result.current.deleteTransaction('dup'); });
  queryClient.clear();
  held.release();
  await act(async () => { await pending; });

  expect(queryClient.getQueryData(['transactions'])).toBeUndefined();
  expect(queryClient.getQueryData(['transactionsRecent'])).toBeUndefined();
});
