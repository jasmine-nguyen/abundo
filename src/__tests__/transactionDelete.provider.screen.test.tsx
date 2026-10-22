// WHIT-654 — deleteTransaction: the user removes one charge (e.g. a duplicate) from the detail
// screen. Drives the REAL action through AppProvider over the fake server. Proves the charge leaves
// every cached copy at once, the totals are marked for a refresh, and a failed delete puts every
// copy back and warns.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, seedTransactionsPages, readTransactionsCache, type FeedPage } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper as wrapper } from './support/renderWithApp';
import { anthropicSubTxn as txn } from './factory';

const server = installFakeServer();

const KEEP = txn({ transaction_id: 'keep', status: 'posted' });
const OLDER = txn({ transaction_id: 'older', status: 'posted', date: '2026-08-01' });

function seedEveryCopy() {
  seedTransactionsCache(queryClient, [txn(), KEEP]);
  queryClient.setQueryData(['transactionsSearch', 'claude'], { transactions: [txn(), KEEP], truncated: false });
  queryClient.setQueryData(['budgetTransactions', 'subscriptions'], [txn(), KEEP]);
  queryClient.setQueryData(['categoryTransactions', 'subscriptions'], [txn()]);
}

// The duplicate sits on page 2 of the feed, so the removal must walk every loaded page.
function seedPagedFeeds() {
  seedTransactionsPages(queryClient, [
    { transactions: [KEEP], nextCursor: 'c1' },
    { transactions: [txn(), OLDER], nextCursor: null },
  ]);
  queryClient.setQueryData(['uncategorizedFeed'], { pages: [{ transactions: [txn(), KEEP], nextCursor: null }], pageParams: [undefined] });
  queryClient.setQueryData(['transactionsRecent'], [txn(), KEEP]);
}

function ids(rows: Transaction[] | undefined) {
  return (rows ?? []).map((row) => row.transaction_id);
}

type Feed = { pages: FeedPage[] };
const uncategorizedIds = () => ids(queryClient.getQueryData<Feed>(['uncategorizedFeed'])?.pages.flatMap((p) => p.transactions));
const recentIds = () => ids(queryClient.getQueryData<Transaction[]>(['transactionsRecent']));

async function mount() { return (await renderHook(() => useAppContext(), { wrapper })).result; }

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('removes the charge from the feed, search and the budget and category lists, and refreshes the totals', async () => {
  seedEveryCopy();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const result = await mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteTransaction('dup'); });

  expect(ok).toBe(true);
  expect(server.requests()).toContainEqual({ method: 'DELETE', path: '/transactions/dup', body: undefined });
  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep']);
  expect(ids(queryClient.getQueryData<{ transactions: Transaction[] }>(['transactionsSearch', 'claude'])?.transactions)).toEqual(['keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['budgetTransactions', 'subscriptions']))).toEqual(['keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['categoryTransactions', 'subscriptions']))).toEqual([]);
  const refreshed = invalidatedKeys(invalidate);
  expect(refreshed).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'uncategorizedCount']));
  invalidate.mockRestore();
});

it('a failed delete puts the charge back everywhere and warns', async () => {
  seedEveryCopy();
  server.fail('/transactions/dup', 500);
  const result = await mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteTransaction('dup'); });

  expect(ok).toBe(false);
  expect(ids(readTransactionsCache(queryClient))).toEqual(['dup', 'keep']);
  expect(ids(queryClient.getQueryData<{ transactions: Transaction[] }>(['transactionsSearch', 'claude'])?.transactions)).toEqual(['dup', 'keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['budgetTransactions', 'subscriptions']))).toEqual(['dup', 'keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['categoryTransactions', 'subscriptions']))).toEqual(['dup']);
  expect(result.current.toast).toBe('Could not delete. Please try again.');
});

it('drops the charge from the uncategorized feed, the recent window and a deep feed page, keeping page shape', async () => {
  seedPagedFeeds();
  const result = await mount();
  await act(async () => { await result.current.deleteTransaction('dup'); });

  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep', 'older']);
  expect(queryClient.getQueryData<Feed>(['transactions'])?.pages.map((p) => p.nextCursor)).toEqual(['c1', null]);
  expect(uncategorizedIds()).toEqual(['keep']);
  expect(recentIds()).toEqual(['keep']);
});

it('removes the charge at once, before the server answers', async () => {
  seedPagedFeeds();
  const held = server.hold('/transactions/dup');
  const result = await mount();

  let pending!: Promise<boolean>;
  await act(() => { pending = result.current.deleteTransaction('dup'); });
  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep', 'older']);
  expect(uncategorizedIds()).toEqual(['keep']);
  expect(recentIds()).toEqual(['keep']);

  held.release();
  await act(async () => { await pending; });
  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep', 'older']);
});

it('success refreshes the totals and the scoped lists, never the paged feeds (no refetch storm)', async () => {
  seedPagedFeeds();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const result = await mount();
  await act(async () => { await result.current.deleteTransaction('dup'); });

  const refreshed = invalidatedKeys(invalidate);
  expect(refreshed).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'budgetTransactions', 'categoryTransactions', 'uncategorizedCount']));
  expect(refreshed).not.toContain('transactions');
  expect(refreshed).not.toContain('uncategorizedFeed');
  invalidate.mockRestore();
});

it('a rollback after the caches were cleared (signed out mid-delete) does not bring data back', async () => {
  seedPagedFeeds();
  server.fail('/transactions/dup', 500);
  const held = server.hold('/transactions/dup');
  const result = await mount();

  let pending!: Promise<boolean>;
  await act(() => { pending = result.current.deleteTransaction('dup'); });
  queryClient.clear();
  held.release();
  await act(async () => { await pending; });

  expect(queryClient.getQueryData(['transactions'])).toBeUndefined();
  expect(queryClient.getQueryData(['transactionsRecent'])).toBeUndefined();
});
