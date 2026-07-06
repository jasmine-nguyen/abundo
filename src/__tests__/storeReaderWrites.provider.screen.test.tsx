// WHIT-203 — the writers whose migrated readers moved to the query layer now keep those
// caches live: persistPayCycle double-writes ['payCycle'] (the pay-cycle sheet reads it);
// saveCategory invalidates ['categories'] (the category screens read it); and
// deleteCategory MIRRORS its cross-screen cascade into the ['categories']/['budgets',*]/
// ['transactions'] caches WITHOUT invalidating — the server does no cascade, so a refetch
// would resurrect the just-dropped rows. Drives the REAL writers via AppProvider + the
// singleton queryClient. Caches are seeded first (as if a screen had loaded them).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Budget, Category, Transaction } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const CAT: Category = { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 };
const OTHER: Category = { id: 'rent', name: 'Rent', bucket: 'Living', icon: 'home', color: '#8AB4F8', recent: 0 };
const BUDGET: Budget = { id: 'coffee', budget: 100, posted: 40, pending: 10 };
const TXN: Transaction = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01', description: 'X', merchant_name: 'X',
  amount: -5, account_id: 'a', account_name: 'A', category: 'coffee', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
};

beforeEach(() => {
  queryClient.clear();
  mockApi.fetchTransactions.mockResolvedValue([]);
  mockApi.fetchCategories.mockResolvedValue([]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchBreakdown.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchLoanFacts.mockResolvedValue({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.listEnrichments.mockResolvedValue([]);
});
afterEach(() => { queryClient.clear(); });

async function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper: ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider> });
  await waitFor(() => expect(result.current.categories).toBeDefined());
  return result;
}

it('persistPayCycle double-writes the [payCycle] cache (so the migrated sheet/Settings reflect it)', async () => {
  mockApi.setPayCycle.mockResolvedValue({ length: 30, last_pay_date: '2024-01-03' });
  const result = await mount();
  queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2024-01-03' });

  await act(async () => { result.current.setPayCycleLength(30); });

  expect(queryClient.getQueryData<{ length: number }>(['payCycle'])?.length).toBe(30);
});

it('saveCategory mirrors the new category into [categories] instantly AND invalidates to reconcile', async () => {
  mockApi.createCategory.mockResolvedValue({ id: 'new', name: 'New', bucket: 'Living', icon: 'home', color: '#fff', recent: 0 } as never);
  const result = await mount();
  queryClient.setQueryData<Category[]>(['categories'], [OTHER]); // as a mounted category screen would have
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.saveCategory(null, { name: 'New', bucket: 'Living', icon: 'home' }); });

  // The created category appears in the cache the migrated screens read (instant, no round-trip)...
  expect(queryClient.getQueryData<Category[]>(['categories'])?.map((c) => c.id)).toContain('new');
  // ...and the invalidate reconciles with the server.
  const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toContain('categories');
  invalidate.mockRestore();
});

it('deleteCategory MIRRORS the cascade into the caches without invalidating (no resurrection)', async () => {
  mockApi.deleteCategory.mockResolvedValue(undefined as never);
  const result = await mount();
  // Seed the caches as a mounted screen would have.
  queryClient.setQueryData<Category[]>(['categories'], [CAT, OTHER]);
  queryClient.setQueryData<Budget[]>(['budgets', 14], [BUDGET]);
  queryClient.setQueryData<Transaction[]>(['transactions'], [TXN]);
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteCategory('coffee'); });

  // Dropped from every cache the migrated screens read...
  expect(queryClient.getQueryData<Category[]>(['categories'])).toEqual([OTHER]);
  expect(queryClient.getQueryData<Budget[]>(['budgets', 14])).toEqual([]);
  expect(queryClient.getQueryData<Transaction[]>(['transactions'])?.[0].category).toBeNull();
  // ...via setQueryData, NOT invalidate — a refetch would resurrect them (server does no cascade).
  const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).not.toContain('categories');
  expect(keys).not.toContain('budgets');
  expect(keys).not.toContain('transactions');
  invalidate.mockRestore();
});
