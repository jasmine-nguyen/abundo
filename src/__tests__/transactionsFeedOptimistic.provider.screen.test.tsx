// The feed's InfiniteData cache under optimistic writes — proves a row on a PAGED-IN (page 2)
// batch updates IN PLACE across pages, and the page/cursor structure survives (the write path
// maps its row transform per page; no add/remove). Without the InfiniteData-aware patch/read the
// paged-in row would never update. Drives the REAL applyTransactionEdit + applyCategoryToMany
// through AppProvider (../api + ../auth mocked).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsPages, type FeedPage } from './support/transactionsCache';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (id: string): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});
const pages = (): FeedPage[] =>
  (queryClient.getQueryData(['transactions']) as { pages: FeedPage[] }).pages;
const recentRows = (): Transaction[] => queryClient.getQueryData<Transaction[]>(['transactionsRecent']) ?? [];

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) => ({
    results: updates.map((u) => ({ id: u.id, status: 'updated' as const })),
  }));
});
afterEach(() => { queryClient.clear(); }); // clear the singleton's gcTime timers

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
