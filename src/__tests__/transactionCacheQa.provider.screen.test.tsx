// WHIT-627 QA — every writer that now goes through src/transactionCache.ts, driven through the real
// AppProvider against a seeded cache and checked by what each saved copy shows afterwards (no
// spying on which refresh calls ran). The implementer's test covers applyCategoryToMany's partial
// failure; these cover the other writers and the edges:
//   [A1] applyCategory('one') success   [A2] applyCategory('one') failure (non-null previous)
//   [A3] applyCategory('all') partial failure + WHIT-524 (a stale budget-only copy is not swept)
//   [A4] applyCategoryToMany total failure → nothing refreshed, budget list whole again
//   [A5] applyCategoryToMany with ids only in a budget list → no-op (writers skip scoped lists)
//   [A6] applyTransactionEdit exclude → every copy stamped, exclusion refresh set
//   [A7] applyTransactionEdit note → no refresh; failure restores every copy
//   [A8] deleteCategory → category-deleted refresh set
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import type { TransactionFeedPage, TransactionSearchResult } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { DELETE_DINING, DELETE_GROCERIES, tx, page } from './support/deleteCategorySeed';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const CATEGORIES = [DELETE_DINING, DELETE_GROCERIES];

const SEARCH_KEY = ['transactionsSearch', 'all', 'coles'];
const BUDGET_KEY = ['budgetTransactions', 'dining'];
const CATEGORY_KEY = ['categoryTransactions', 'dining', 0];
const BUDGETS_KEY = ['budgets', 14];
const BREAKDOWN_KEY = ['breakdown', 14, 0];
const COUNT_KEY = ['uncategorizedCount'];
const UNCAT_KEY = ['uncategorizedFeed'];

function seedServerDerived() {
  queryClient.setQueryData(['categories'], CATEGORIES);
  queryClient.setQueryData(['rules'], []);
  queryClient.setQueryData(BUDGETS_KEY, {});
  queryClient.setQueryData(BREAKDOWN_KEY, {});
  queryClient.setQueryData(COUNT_KEY, 1);
}

const byId = (rows: Transaction[] | undefined) => Object.fromEntries((rows ?? []).map((t) => [t.transaction_id, t]));
const categoryOf = (rows: Transaction[] | undefined) =>
  Object.fromEntries((rows ?? []).map((t) => [t.transaction_id, t.category]));
const feedRows = (key: string) =>
  queryClient.getQueryData<InfiniteData<TransactionFeedPage>>([key])?.pages.flatMap((p) => p.transactions);
const recentRows = () => queryClient.getQueryData<Transaction[]>(['transactionsRecent']);
const searchRows = () => queryClient.getQueryData<TransactionSearchResult>(SEARCH_KEY)?.transactions;
const listRows = (key: QueryKey) => queryClient.getQueryData<Transaction[]>(key);
const listIds = (key: QueryKey) => listRows(key)?.map((t) => t.transaction_id);
const invalidated = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated;

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

// [A1]
it("applyCategory('one') files the charge in every main copy, drops it from the old budget's list and refreshes the re-file set", async () => {
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2')]));
  queryClient.setQueryData(UNCAT_KEY, page([]));
  queryClient.setQueryData(['transactionsRecent'], [tx('t1')]);
  queryClient.setQueryData(SEARCH_KEY, { transactions: [tx('t1')], truncated: false });
  queryClient.setQueryData(BUDGET_KEY, [tx('t1'), tx('t2')]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('t1'), tx('t2')]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('one'); });

  expect(server.requests()).toContainEqual({ method: 'PATCH', path: '/transactions/t1', body: { category: 'groceries' } });
  expect(categoryOf(feedRows('transactions'))).toEqual({ t1: 'groceries', t2: 'dining' });
  expect(categoryOf(recentRows())).toEqual({ t1: 'groceries' });
  expect(categoryOf(searchRows())).toEqual({ t1: 'groceries' });
  expect(listIds(BUDGET_KEY)).toEqual(['t2']);
  // WHIT-524: a re-file never stamps the category drill-in list; the refresh rebuilds it.
  expect(categoryOf(listRows(CATEGORY_KEY))).toEqual({ t1: 'dining', t2: 'dining' });

  for (const key of [BUDGETS_KEY, BREAKDOWN_KEY, BUDGET_KEY, CATEGORY_KEY, COUNT_KEY]) {
    expect([key, invalidated(key)]).toEqual([key, true]);
  }
  expect(invalidated(SEARCH_KEY)).toBe(false);
  expect(invalidated(UNCAT_KEY)).toBe(false);
  expect(invalidated(['transactions'])).toBe(false);
  expect(invalidated(['categories'])).toBe(false);
  expect(invalidated(['rules'])).toBe(false);
});

// [A2]
it("applyCategory('one') failure puts the charge back to its OWN old category everywhere and restores the budget list", async () => {
  server.fail('/transactions/t1', 500);
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2')]));
  queryClient.setQueryData(['transactionsRecent'], [tx('t1')]);
  queryClient.setQueryData(SEARCH_KEY, { transactions: [tx('t1')], truncated: false });
  queryClient.setQueryData(BUDGET_KEY, [tx('t1'), tx('t2')]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('one'); });

  expect(categoryOf(feedRows('transactions'))).toEqual({ t1: 'dining', t2: 'dining' });
  expect(categoryOf(recentRows())).toEqual({ t1: 'dining' });
  expect(categoryOf(searchRows())).toEqual({ t1: 'dining' });
  expect(listIds(BUDGET_KEY)).toEqual(['t1', 't2']);
  expect(result.current.toast).toBe('Could not save category. Please try again.');
  for (const key of [BUDGETS_KEY, BREAKDOWN_KEY, BUDGET_KEY, COUNT_KEY]) {
    expect([key, invalidated(key)]).toEqual([key, false]);
  }
});

// [A3]
it("applyCategory('all') sweeps only the main copies, rolls back just the failed charge, and keeps the saved one out of the old budget list", async () => {
  // t1 tapped (dining), t2 unfiled same merchant (saves), t3 unfiled same merchant (fails).
  // t9 is an unfiled same-merchant charge that exists ONLY in a budget list — a stale scoped copy
  // that a re-file sweep must never pick up (WHIT-524).
  server.once('PATCH', '/transactions', {
    body: { results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'updated' }, { id: 't3', status: 'error' }] },
  });
  server.once('POST', '/rules', { body: { id: 'r1', value: 'COLES', categoryId: 'groceries', field: 'description', operator: 'contains' } });
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2', { category: null })]));
  queryClient.setQueryData(UNCAT_KEY, page([tx('t2', { category: null }), tx('t3', { category: null })]));
  queryClient.setQueryData(BUDGET_KEY, [tx('t1'), tx('t9', { category: null })]);
  const result = mount();
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('all'); });

  const batchSaves = server.sent('PATCH', '/transactions');
  const sent = (batchSaves[0].body as { updates: { id: string }[] }).updates;
  expect(sent.map((item) => item.id).sort()).toEqual(['t1', 't2', 't3']);
  expect(categoryOf(feedRows('transactions'))).toEqual({ t1: 'groceries', t2: 'groceries' });
  expect(categoryOf(feedRows('uncategorizedFeed'))).toEqual({ t2: 'groceries', t3: null });
  // t1 saved → stays out of the dining budget list; t9 was never touched.
  expect(listIds(BUDGET_KEY)).toEqual(['t9']);
  expect(byId(listRows(BUDGET_KEY)).t9.category).toBeNull();
  expect(invalidated(BUDGETS_KEY)).toBe(true);
  expect(invalidated(COUNT_KEY)).toBe(true);
  expect(invalidated(BUDGET_KEY)).toBe(true);
});

// [A4]
it('applyCategoryToMany where every save fails restores every copy and marks nothing for a refresh', async () => {
  server.once('PATCH', '/transactions', {
    body: { results: [{ id: 't1', status: 'error' }, { id: 't2', status: 'error' }] },
  });
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2', { category: null })]));
  queryClient.setQueryData(SEARCH_KEY, { transactions: [tx('t2', { category: null })], truncated: false });
  queryClient.setQueryData(BUDGET_KEY, [tx('t1')]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('t1')]);
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(categoryOf(feedRows('transactions'))).toEqual({ t1: 'dining', t2: null });
  expect(categoryOf(searchRows())).toEqual({ t2: null });
  expect(listIds(BUDGET_KEY)).toEqual(['t1']);
  for (const key of [BUDGETS_KEY, BREAKDOWN_KEY, BUDGET_KEY, CATEGORY_KEY, COUNT_KEY]) {
    expect([key, invalidated(key)]).toEqual([key, false]);
  }
});

// [A5]
it('applyCategoryToMany ignores a charge that lives only in a budget/category list (writers skip scoped lists)', async () => {
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([]));
  queryClient.setQueryData(BUDGET_KEY, [tx('only-budget')]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('only-budget')]);
  const result = mount();

  await act(async () => { await result.current.applyCategoryToMany(['only-budget'], 'groceries'); });

  expect(server.sent('PATCH', '/transactions')).toHaveLength(0);
  expect(listIds(BUDGET_KEY)).toEqual(['only-budget']);
  expect(invalidated(BUDGETS_KEY)).toBe(false);
});

// [A6]
it('applyTransactionEdit exclude stamps every copy (main + scoped) and refreshes the exclusion set, not the tally', async () => {
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([tx('t1')]));
  queryClient.setQueryData(['transactionsRecent'], [tx('t1')]);
  queryClient.setQueryData(SEARCH_KEY, { transactions: [tx('t1')], truncated: false });
  queryClient.setQueryData(BUDGET_KEY, [tx('t1')]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('t1')]);
  const result = mount();

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(byId(feedRows('transactions')).t1.budget_excluded).toBe(true);
  expect(byId(recentRows()).t1.budget_excluded).toBe(true);
  expect(byId(searchRows()).t1.budget_excluded).toBe(true);
  expect(byId(listRows(BUDGET_KEY)).t1.budget_excluded).toBe(true);
  expect(byId(listRows(CATEGORY_KEY)).t1.budget_excluded).toBe(true);
  for (const key of [BUDGETS_KEY, BREAKDOWN_KEY, BUDGET_KEY, CATEGORY_KEY]) {
    expect([key, invalidated(key)]).toEqual([key, true]);
  }
  expect(invalidated(COUNT_KEY)).toBe(false);
  expect(invalidated(SEARCH_KEY)).toBe(false);
});

// [A7]
it('applyTransactionEdit on a budget-only charge: a note edit refreshes nothing; a failed save restores every copy', async () => {
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([]));
  queryClient.setQueryData(BUDGET_KEY, [tx('old', { notes: 'before' })]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('old', { notes: 'before' })]);
  const result = mount();

  await act(async () => { await result.current.applyTransactionEdit('old', { notes: 'after' }); });
  expect(byId(listRows(BUDGET_KEY)).old.notes).toBe('after');
  expect(byId(listRows(CATEGORY_KEY)).old.notes).toBe('after');
  for (const key of [BUDGETS_KEY, BREAKDOWN_KEY, BUDGET_KEY, CATEGORY_KEY, COUNT_KEY]) {
    expect([key, invalidated(key)]).toEqual([key, false]);
  }

  server.once('PATCH', '/transactions/old', { status: 500 });
  await act(async () => { await result.current.applyTransactionEdit('old', { notes: 'lost' }); });
  expect(byId(listRows(BUDGET_KEY)).old.notes).toBe('after');
  expect(byId(listRows(CATEGORY_KEY)).old.notes).toBe('after');
});

// [A8]
it('deleteCategory unfiles its charges in every copy and refreshes the category-deleted set', async () => {
  seedServerDerived();
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2', { category: 'groceries' })]));
  queryClient.setQueryData(UNCAT_KEY, page([]));
  queryClient.setQueryData(SEARCH_KEY, { transactions: [tx('t1')], truncated: false });
  queryClient.setQueryData(BUDGET_KEY, [tx('t1')]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('t1')]);
  const result = mount();

  await act(async () => { await result.current.deleteCategory('dining'); });

  expect(categoryOf(feedRows('transactions'))).toEqual({ t1: null, t2: 'groceries' });
  expect(categoryOf(searchRows())).toEqual({ t1: null });
  // WHIT-628: the budget / category charge lists are unfiled too, and reload.
  expect(categoryOf(listRows(BUDGET_KEY))).toEqual({ t1: null });
  expect(categoryOf(listRows(CATEGORY_KEY))).toEqual({ t1: null });
  for (const key of [BREAKDOWN_KEY, COUNT_KEY, UNCAT_KEY, SEARCH_KEY, BUDGET_KEY, CATEGORY_KEY]) {
    expect([key, invalidated(key)]).toEqual([key, true]);
  }
  // Budgets are cascaded by hand (a refetch would resurrect the dropped budget).
  expect(invalidated(BUDGETS_KEY)).toBe(false);
  expect(invalidated(['transactions'])).toBe(false);
});
