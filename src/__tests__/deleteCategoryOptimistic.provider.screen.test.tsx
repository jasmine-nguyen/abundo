// WHIT-628 slice 2 — deleting a category is instant, undoes on failure, and reaches every copy of
// its charges: the main copies AND the budget / category charge lists (which also reload).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category, Rule } from '../context';
import type { TransactionFeedPage } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {}, getAuthToken: async () => 'test-id-token' }));
import { installFakeServer } from './support/fakeServer';

const server = installFakeServer();

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const DINING: Category = { id: 'dining', name: 'Dining', bucket: 'Living', icon: 'food', color: '#f00', recent: 0, parent: null };
const GROCERIES: Category = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#0f0', recent: 0, parent: null };
const DINING_RULE: Rule = { id: 'r1', pattern: 'COLES', categoryId: 'dining', isNew: false };
const GROCERIES_RULE: Rule = { id: 'r2', pattern: 'WOOLIES', categoryId: 'groceries', isNew: false };
const DINING_BUDGET = { target: 200, posted: 12.5, pending: 0 };
const GROCERIES_BUDGET = { target: 300, posted: 0, pending: 0 };

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES 0412 SYDNEY', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: 'dining', status: 'posted', type: 'PAYMENT', counts_to_budget: true, ...over,
});
const page = (transactions: Transaction[]) => ({ pages: [{ transactions, nextCursor: null }], pageParams: [undefined] });

// A parent budget's charge list holding a Dining charge, and the Insights drill-in for Dining.
const BUDGET_KEY = ['budgetTransactions', 'parentBudget'];
const CATEGORY_KEY = ['categoryTransactions', 'dining', 0];
const BUDGETS_KEY = ['budgets', 14];

function seed() {
  queryClient.setQueryData(['categories'], [DINING, GROCERIES]);
  queryClient.setQueryData(['rules'], [DINING_RULE, GROCERIES_RULE]);
  queryClient.setQueryData(BUDGETS_KEY, { dining: DINING_BUDGET, groceries: GROCERIES_BUDGET });
  queryClient.setQueryData(['transactions'], page([tx('t1'), tx('t2', { category: 'groceries' })]));
  queryClient.setQueryData(BUDGET_KEY, [tx('t1'), tx('t2', { category: 'groceries' })]);
  queryClient.setQueryData(CATEGORY_KEY, [tx('t1')]);
}

const categoryOf = (rows: Transaction[] | undefined) =>
  Object.fromEntries((rows ?? []).map((t) => [t.transaction_id, t.category]));
const feedRows = () =>
  queryClient.getQueryData<InfiniteData<TransactionFeedPage>>(['transactions'])?.pages.flatMap((p) => p.transactions);
const listRows = (key: QueryKey) => queryClient.getQueryData<Transaction[]>(key);
const categoryIds = () => queryClient.getQueryData<Category[]>(['categories'])?.map((c) => c.id);
const ruleIds = () => queryClient.getQueryData<Rule[]>(['rules'])?.map((r) => r.id);
const invalidated = (key: QueryKey) => queryClient.getQueryState(key)?.isInvalidated;

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('deleting a category unfiles its charges on screen instantly, undoes on failure, and on success leaves every charge list showing them uncategorised', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  // 1. A failed delete: the screen changes before the server replies, then everything is put back.
  const failing = server.hold('/categories/dining');
  let failedOk: boolean | undefined;
  let failedDelete!: Promise<void>;
  act(() => { failedDelete = result.current.deleteCategory('dining').then((ok) => { failedOk = ok; }); });

  expect(categoryIds()).toEqual(['groceries']);
  expect(ruleIds()).toEqual(['r2']);
  expect(queryClient.getQueryData(BUDGETS_KEY)).toEqual({ groceries: GROCERIES_BUDGET });
  expect(categoryOf(feedRows())).toEqual({ t1: null, t2: 'groceries' });
  expect(categoryOf(listRows(BUDGET_KEY))).toEqual({ t1: null, t2: 'groceries' });
  expect(categoryOf(listRows(CATEGORY_KEY))).toEqual({ t1: null });

  await act(async () => {
    server.once('DELETE', '/categories/dining', 'dropped');
    failing.release();
    await failedDelete;
  });

  expect(failedOk).toBe(false);
  expect(categoryIds()).toEqual(['dining', 'groceries']);
  expect(ruleIds()).toEqual(['r1', 'r2']);
  expect(queryClient.getQueryData(BUDGETS_KEY)).toEqual({ dining: DINING_BUDGET, groceries: GROCERIES_BUDGET });
  expect(categoryOf(feedRows())).toEqual({ t1: 'dining', t2: 'groceries' });
  expect(categoryOf(listRows(BUDGET_KEY))).toEqual({ t1: 'dining', t2: 'groceries' });
  expect(categoryOf(listRows(CATEGORY_KEY))).toEqual({ t1: 'dining' });
  expect(result.current.toast).toBe('Could not delete category. Please try again.');
  expect(invalidated(BUDGET_KEY)).toBe(false);
  expect(invalidated(CATEGORY_KEY)).toBe(false);

  // 2. A successful delete: every copy shows the charge uncategorised, and the charge lists reload.
  let savedOk: boolean | undefined;
  await act(async () => { savedOk = await result.current.deleteCategory('dining'); });

  expect(savedOk).toBe(true);
  expect(categoryOf(feedRows())).toEqual({ t1: null, t2: 'groceries' });
  expect(categoryOf(listRows(BUDGET_KEY))).toEqual({ t1: null, t2: 'groceries' });
  expect(categoryOf(listRows(CATEGORY_KEY))).toEqual({ t1: null });
  expect(result.current.toast).toBe('Category deleted.');
  expect(invalidated(BUDGET_KEY)).toBe(true);
  expect(invalidated(CATEGORY_KEY)).toBe(true);
  // Budgets are cascaded by hand; a refetch would resurrect the dropped budget.
  expect(invalidated(BUDGETS_KEY)).toBe(false);
});
