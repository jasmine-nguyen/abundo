// WHIT-203 GAP — the mirror caches must reach a LIVE mounted observer, not just sit in the
// cache. storeReaderWrites.provider asserts getQueryData + an invalidate spy; this asserts
// the migrated readers' hooks (usePayCycle / useCategories), mounted under the SAME
// singleton queryClient the writers write to, re-render correctly:
//   - setPayCycleLength → usePayCycle read-your-write (persistPayCycle double-write).
//   - deleteCategory   → useCategories drops it AND no categories refetch fires (the server
//                        does no cascade, so an invalidate would resurrect it on refetch).
//   - saveCategory     → useCategories reflects the new category via the invalidate→refetch.
// Real writers via AppProvider; real observers via QueryClientProvider(client=singleton).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProvider, useAppContext } from '../context';
import type { Category } from '../context';
import { useCategories, usePayCycle } from '../queries';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const CAT: Category = { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 0 };
const OTHER: Category = { id: 'rent', name: 'Rent', bucket: 'Living', icon: 'home', color: '#8AB4F8', recent: 0 };
const NEW: Category = { id: 'new', name: 'New', bucket: 'Living', icon: 'home', color: '#fff', recent: 0 };

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

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <AppProvider>{children}</AppProvider>
  </QueryClientProvider>
);

it('usePayCycle observer reflects setPayCycleLength immediately (read-your-write)', async () => {
  mockApi.setPayCycle.mockResolvedValue({ length: 30, last_pay_date: '2024-01-03' } as never);
  const { result } = renderHook(() => ({ ctx: useAppContext(), pc: usePayCycle() }), { wrapper });

  // Let the initial payCycle fetch settle first so it can't overwrite our write late.
  await waitFor(() => expect(queryClient.getQueryData(['payCycle'])).toBeTruthy());
  expect(result.current.pc.cycleName()).toBe('Fortnightly'); // fetched length 14

  await act(async () => { result.current.ctx.setPayCycleLength(30); });

  await waitFor(() => expect(result.current.pc.cycleName()).toBe('Monthly'));
  expect(result.current.pc.cycleLen).toBe(30);
});

it('useCategories observer drops a deleted category and does NOT refetch it (no resurrection)', async () => {
  // The static mock still returns coffee — so a stray refetch WOULD resurrect it, which is
  // exactly what must not happen (delete uses setQueryData, not invalidate).
  mockApi.fetchCategories.mockResolvedValue([CAT, OTHER]);
  mockApi.deleteCategory.mockResolvedValue(undefined as never);
  const { result } = renderHook(() => ({ ctx: useAppContext(), cats: useCategories() }), { wrapper });

  await waitFor(() => expect(result.current.cats.categories).toHaveLength(2));
  const fetchCalls = mockApi.fetchCategories.mock.calls.length;

  await act(async () => { await result.current.ctx.deleteCategory('coffee'); });

  await waitFor(() => expect(result.current.cats.categories).toHaveLength(1));
  expect(result.current.cats.category('coffee')).toBeUndefined();
  expect(result.current.cats.category('rent')?.name).toBe('Rent');
  // No categories refetch — the server does no cascade, so a refetch would bring coffee back.
  expect(mockApi.fetchCategories.mock.calls.length).toBe(fetchCalls);
});

it('useCategories observer shows a newly-created category via the invalidate refetch', async () => {
  mockApi.fetchCategories.mockResolvedValue([CAT]);
  const { result } = renderHook(() => ({ ctx: useAppContext(), cats: useCategories() }), { wrapper });
  await waitFor(() => expect(result.current.cats.categories).toHaveLength(1));

  mockApi.createCategory.mockResolvedValue(NEW as never);
  mockApi.fetchCategories.mockResolvedValue([CAT, NEW]); // what the invalidate-triggered refetch returns

  await act(async () => { await result.current.ctx.saveCategory(null, { name: 'New', bucket: 'Living', icon: 'home' }); });

  await waitFor(() => expect(result.current.cats.category('new')?.name).toBe('New'));
  expect(result.current.cats.categories).toHaveLength(2);
});
