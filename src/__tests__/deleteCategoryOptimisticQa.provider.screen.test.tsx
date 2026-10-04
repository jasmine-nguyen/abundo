// WHIT-628 slice 2 QA — the adversarial half of deleteCategory's optimistic cascade: sign-out
// mid-delete must re-seat nothing, the undo puts back exactly what it changed, and every copy
// (main + scoped, every cycle) is unfiled.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import type { InfiniteData, QueryKey } from '@tanstack/react-query';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => {
  mockStatus = s;
  mockListeners.forEach((l) => l());
};
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (l: () => void) => mockSubscribe(l),
  getAuthToken: async () => 'test-id-token',
}));

import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category } from '../types';
import type { Rule } from '../model';
import type { TransactionFeedPage, TransactionSearchResult } from '../api';
import { queryClient } from '../queryClient';
import { installFakeServer } from './support/fakeServer';
import {
  DELETE_DINING, DELETE_GROCERIES, DELETE_DINING_RULE, DELETE_GROCERIES_RULE, DELETE_DINING_BUDGET, DELETE_GROCERIES_BUDGET, tx, page,
} from './support/deleteCategorySeed';

const server = installFakeServer();

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const BUDGET_KEY = ['budgetTransactions', 'parentBudget'];
const OTHER_BUDGET_KEY = ['budgetTransactions', 'otherBudget'];
const CATEGORY_KEY = ['categoryTransactions', 'dining', 0];
const PREV_CYCLE_CATEGORY_KEY = ['categoryTransactions', 'dining', 1];
const BUDGETS_KEY = ['budgets', 14];
const BUDGETS_KEY_28 = ['budgets', 28];
const SEARCH_KEY = ['transactionsSearch', 'coles'];

// t1 is in Dining; t2 in Groceries; t3 was already uncategorised (must never become Dining on undo).
function seed() {
  queryClient.setQueryData(['categories'], [DELETE_DINING, DELETE_GROCERIES]);
  queryClient.setQueryData(['rules'], [DELETE_DINING_RULE, DELETE_GROCERIES_RULE]);
  queryClient.setQueryData(BUDGETS_KEY, { dining: DELETE_DINING_BUDGET, groceries: DELETE_GROCERIES_BUDGET });
  queryClient.setQueryData(BUDGETS_KEY_28, { dining: DELETE_DINING_BUDGET });
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2', { category: 'groceries' }), tx('t3', { category: null })]));
  queryClient.setQueryData(['uncategorizedFeed'], page([tx('t3', { category: null })]));
  queryClient.setQueryData(['transactionsRecent'], [tx('t1'), tx('t3', { category: null })]);
  queryClient.setQueryData<TransactionSearchResult>(SEARCH_KEY, { transactions: [tx('t1')] } as TransactionSearchResult);
  queryClient.setQueryData(BUDGET_KEY, [tx('t1'), tx('t2', { category: 'groceries' })]);
  queryClient.setQueryData(OTHER_BUDGET_KEY, [tx('t3', { category: null }), tx('t4', { category: 'groceries' })]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('t1')]);
  // A charge that only lives in an older cycle's drill-in list (never loaded in the feed).
  queryClient.setQueryData(PREV_CYCLE_CATEGORY_KEY, [tx('t9')]);
}

const categoryOf = (rows: Transaction[] | undefined) =>
  Object.fromEntries((rows ?? []).map((t) => [t.transaction_id, t.category]));
const feedRows = (key: QueryKey) =>
  queryClient.getQueryData<InfiniteData<TransactionFeedPage>>(key)?.pages.flatMap((p) => p.transactions);
const listRows = (key: QueryKey) => queryClient.getQueryData<Transaction[]>(key);
const searchRows = () => queryClient.getQueryData<TransactionSearchResult>(SEARCH_KEY)?.transactions;
const invalidated = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated;

// Production order: clearSession() wipes the cache, THEN broadcasts anon (the epoch bump).
function signOut() {
  act(() => { queryClient.clear(); mockSetStatus('anon'); });
}

// The delete waits on the server until resolve() (it succeeds) or reject(reply) (it gets `reply`).
async function startDelete(result: { current: ReturnType<typeof useAppContext> }) {
  const held = server.hold('/categories/dining');
  let pending!: Promise<boolean>;
  act(() => { pending = result.current.deleteCategory('dining'); });
  const request = {
    resolve: () => held.release(),
    reject: (reply: Parameters<typeof server.once>[2]) => held.fail('DELETE', reply),
  };
  return { request, pending };
}

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); });

// [A1]
it('unfiles the charge in every copy — main copies, every budget list, every cycle of the drill-in — before the server replies', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  const { request, pending } = await startDelete(result);

  expect(categoryOf(feedRows(['transactions']))).toEqual({ t1: null, t2: 'groceries', t3: null });
  expect(categoryOf(listRows(['transactionsRecent']))).toEqual({ t1: null, t3: null });
  expect(categoryOf(searchRows())).toEqual({ t1: null });
  expect(categoryOf(listRows(BUDGET_KEY))).toEqual({ t1: null, t2: 'groceries' });
  expect(categoryOf(listRows(OTHER_BUDGET_KEY))).toEqual({ t3: null, t4: 'groceries' });
  expect(categoryOf(listRows(CATEGORY_KEY))).toEqual({ t1: null });
  expect(categoryOf(listRows(PREV_CYCLE_CATEGORY_KEY))).toEqual({ t9: null });
  // Both budget cycles lose the Dining budget.
  expect(queryClient.getQueryData(BUDGETS_KEY)).toEqual({ groceries: DELETE_GROCERIES_BUDGET });
  expect(queryClient.getQueryData(BUDGETS_KEY_28)).toEqual({});

  await act(async () => { request.resolve(); await pending; });
});

// [A2]
it('a failed delete puts back exactly what it changed: only Dining charges return to Dining, every budget cycle is restored', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  const { request, pending } = await startDelete(result);

  let ok!: boolean;
  await act(async () => { request.reject('dropped'); ok = await pending; });

  expect(ok).toBe(false);
  // t3 was uncategorised before — the undo must not stamp Dining onto it.
  expect(categoryOf(feedRows(['transactions']))).toEqual({ t1: 'dining', t2: 'groceries', t3: null });
  expect(categoryOf(feedRows(['uncategorizedFeed']))).toEqual({ t3: null });
  expect(categoryOf(listRows(['transactionsRecent']))).toEqual({ t1: 'dining', t3: null });
  expect(categoryOf(searchRows())).toEqual({ t1: 'dining' });
  expect(categoryOf(listRows(OTHER_BUDGET_KEY))).toEqual({ t3: null, t4: 'groceries' });
  // t9 lived only in a scoped list — it must still come back.
  expect(categoryOf(listRows(PREV_CYCLE_CATEGORY_KEY))).toEqual({ t9: 'dining' });
  expect(queryClient.getQueryData(BUDGETS_KEY)).toEqual({ dining: DELETE_DINING_BUDGET, groceries: DELETE_GROCERIES_BUDGET });
  expect(queryClient.getQueryData(BUDGETS_KEY_28)).toEqual({ dining: DELETE_DINING_BUDGET });
  expect(queryClient.getQueryData<Rule[]>(['rules'])).toEqual([DELETE_DINING_RULE, DELETE_GROCERIES_RULE]);
  expect(queryClient.getQueryData<Category[]>(['categories'])).toEqual([DELETE_DINING, DELETE_GROCERIES]);
  // Nothing refreshes on failure.
  for (const key of [BUDGET_KEY, CATEGORY_KEY, ['uncategorizedCount'], ['breakdown']]) {
    expect([key, invalidated(key) ?? false]).toEqual([key, false]);
  }
});

// [A3]
it('a failed delete shows the server reason when it gives one', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  const { request, pending } = await startDelete(result);

  await act(async () => {
    request.reject({ status: 400, reason: 'category is in use by a goal' });
    await pending;
  });

  expect(result.current.toast).not.toBe('Could not delete category. Please try again.');
  expect(result.current.toast).toMatch(/in use by a goal/i);
});

// [A4]
it('signing out mid-delete then failing re-seats nothing into the cleared cache and shows no toast', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  const { request, pending } = await startDelete(result);

  signOut();
  let ok!: boolean;
  await act(async () => { request.reject('dropped'); ok = await pending; });

  expect(ok).toBe(false);
  expect(result.current.toast).toBeNull();
  for (const key of [['categories'], ['rules'], BUDGETS_KEY, BUDGETS_KEY_28, BUDGET_KEY, CATEGORY_KEY, PREV_CYCLE_CATEGORY_KEY, ['transactions']]) {
    expect([key, queryClient.getQueryData(key)]).toEqual([key, undefined]);
  }
});

// [A5]
it('signing out mid-delete then succeeding returns false (no navigate-back), no toast, no refresh', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  const { request, pending } = await startDelete(result);

  signOut();
  // The next session loads its own charge lists before the old delete settles.
  queryClient.setQueryData(BUDGET_KEY, [tx('n1', { category: 'dining' })]);
  let ok!: boolean;
  await act(async () => { request.resolve(); ok = await pending; });

  expect(ok).toBe(false);
  expect(result.current.toast).toBeNull();
  expect(invalidated(BUDGET_KEY)).toBe(false);
  expect(categoryOf(listRows(BUDGET_KEY))).toEqual({ n1: 'dining' });
});

// [A6]
it('a delete on a cold cache (nothing loaded) neither crashes nor creates cache entries on failure', async () => {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  const { request, pending } = await startDelete(result);

  let ok!: boolean;
  await act(async () => { request.reject('dropped'); ok = await pending; });

  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not delete category. Please try again.');
  expect(queryClient.getQueryData(['categories'])).toBeUndefined();
  expect(queryClient.getQueryData(['rules'])).toBeUndefined();
});

// [A7]
it('a successful delete refreshes every cycle of the charge lists but never the budgets or the feed', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  const { request, pending } = await startDelete(result);

  let ok!: boolean;
  await act(async () => { request.resolve(); ok = await pending; });

  expect(ok).toBe(true);
  expect(result.current.toast).toBe('Category deleted.');
  for (const key of [BUDGET_KEY, OTHER_BUDGET_KEY, CATEGORY_KEY, PREV_CYCLE_CATEGORY_KEY, SEARCH_KEY, ['uncategorizedFeed']]) {
    expect([key, invalidated(key)]).toEqual([key, true]);
  }
  expect(invalidated(BUDGETS_KEY)).toBe(false);
  expect(invalidated(BUDGETS_KEY_28)).toBe(false);
  expect(invalidated(['transactions'])).toBe(false);
  expect(invalidated(['rules'])).toBe(false);
  // The dropped rule and budget stay dropped after success.
  expect(queryClient.getQueryData<Rule[]>(['rules'])).toEqual([DELETE_GROCERIES_RULE]);
  expect(queryClient.getQueryData(BUDGETS_KEY_28)).toEqual({});
});
