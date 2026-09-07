// WHIT-501 — the ['uncategorizedCount'] cache is the whole-history uncategorized tally that
// feeds the tab badge, the nav-bar dot, and the "All caught up" empty state. staleTime is 5min
// (useUncategorizedCountQuery), so a category write that does NOT invalidate this key serves a
// STALE number for up to 5 minutes — a badge that disagrees with the list the user is looking at.
//
// These lock the contract at every write site that CHANGES which charges are uncategorized:
//   - applyCategory('one')     — files one charge → tally drops.
//   - applyCategoryToMany(...)  — files many charges → tally drops.
//   - deleteCategory(id)        — its charges fall back to Uncategorized → tally RISES.
// And the guard: applyTransactionEdit (a note / budget-exclude edit) never changes a charge's
// category, so it must NOT invalidate this key (a needless refetch on every note save).
//
// Fail-on-revert: drop the `invalidateQueries({ queryKey: ['uncategorizedCount'] })` line at any of
// the three write sites and its test fails.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' }] } as never);
  mockApi.deleteCategory.mockResolvedValue({ id: 'groceries' });
});
afterEach(() => { queryClient.clear(); });

function mount(transactions: Transaction[] = [txn()]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// [A-inval-one] filing one charge lowers the whole-history tally → the badge/dot/empty-state must refetch.
it('applyCategory(one) invalidates uncategorizedCount', async () => {
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategory('one'); });

  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A-inval-many] a bulk file lowers the tally too — same contract via applyCategoryToMany's own site.
it('applyCategoryToMany invalidates uncategorizedCount', async () => {
  const result = mount([txn(), txn({ transaction_id: 't2' })]);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A-inval-delete] deleting a category pushes its charges BACK to Uncategorized → the tally RISES.
// Without this the badge would under-count the day the user deletes a category.
it('deleteCategory invalidates uncategorizedCount', async () => {
  const result = mount([txn({ category: 'groceries' })]);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteCategory('groceries'); });

  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A-inval-guard] a note / budget-exclude edit never changes a charge's category, so the uncategorized
// tally can't move — invalidating here would refetch the count on every note save for nothing.
it('applyTransactionEdit does NOT invalidate uncategorizedCount', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', notes: 'lunch' });
  const result = mount([txn({ category: 'groceries' })]);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch' }); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  spy.mockRestore();
});
