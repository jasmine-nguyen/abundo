// WHIT-203/192 — the writers keep the query caches the migrated readers use live:
// persistPayCycle writes ['payCycle'] (the pay-cycle sheet + Settings read it); and deleteCategory
// MIRRORS its cross-screen cascade into the ['categories']/['budgets',*]/['transactions']
// caches WITHOUT invalidating — the server does no cascade, so a refetch would resurrect the
// just-dropped rows. Drives the REAL writers via AppProvider + the singleton queryClient.
// The caches are seeded first (as if a screen had loaded them); the provider no longer
// eager-loads.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Category, Transaction } from '../types';
import type { BudgetRollup } from '../api';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper } from './support/renderWithApp';

const server = installFakeServer();

const CAT: Category = { id: 'coffee', name: 'Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C' };
const OTHER: Category = { id: 'rent', name: 'Rent', bucket: 'Living', icon: 'home', color: '#8AB4F8' };
// The ['budgets', cycleLen] cache holds the RAW queryFn shape — a Record keyed by category
// id (useBudgetsQuery maps it to Budget[] via `select`, which getQueryData does NOT apply).
// Seeding the select-OUTPUT array shape here would let deleteCategory's `.filter`-on-a-Record
// bug pass silently, so seed + assert the real Record.
const BUDGET_ROLLUPS: Record<string, BudgetRollup> = { coffee: { target: 100, posted: 40, pending: 10 } };
const TXN: Transaction = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01', description: 'X', merchant_name: 'X',
  amount: -5, account_id: 'a', account_name: 'A', category: 'coffee', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
};

beforeEach(() => {
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); });

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper: appProviderWrapper });
  return result;
}

it('persistPayCycle writes [payCycle] optimistically AND invalidates payCycle/budgets/breakdown', async () => {
  server.seed('/paycycle', { length: 30, last_pay_date: '2024-01-03', days_left: 30 });
  const result = await mount();
  // Seed a stale server days_left; the optimistic write must NOT carry it forward.
  queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2024-01-03', days_left: 5 });
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { result.current.setPayCycleLength(30); });

  expect(queryClient.getQueryData<{ length: number }>(['payCycle'])?.length).toBe(30);
  // WHIT-341: refetch ['payCycle'] for the server's fresh days_left, alongside budgets/breakdown.
  const keys = invalidatedKeys(invalidate);
  expect(keys).toEqual(expect.arrayContaining(['payCycle', 'budgets', 'breakdown']));
  invalidate.mockRestore();
});

it('deleteCategory MIRRORS the cascade into the caches without invalidating (no resurrection)', async () => {
  const result = await mount();
  // Seed the caches as a mounted screen would have (budgets in the real Record shape).
  queryClient.setQueryData<Category[]>(['categories'], [CAT, OTHER]);
  queryClient.setQueryData<Record<string, BudgetRollup>>(['budgets', 14], { ...BUDGET_ROLLUPS });
  seedTransactionsCache(queryClient, [TXN]);
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteCategory('coffee'); });

  // Dropped from every cache the migrated screens read — the deleted id's KEY is gone from
  // the budgets Record (not filtered as an array, which would throw and abort the cascade).
  expect(queryClient.getQueryData<Category[]>(['categories'])).toEqual([OTHER]);
  expect(queryClient.getQueryData<Record<string, BudgetRollup>>(['budgets', 14])).toEqual({});
  expect(readTransactionsCache(queryClient)[0].category).toBeNull();
  // ...via setQueryData, NOT invalidate — a refetch would resurrect them (server does no cascade).
  const keys = invalidatedKeys(invalidate);
  expect(keys).not.toContain('categories');
  expect(keys).not.toContain('budgets');
  expect(keys).not.toContain('transactions');
  invalidate.mockRestore();
});

it('deleteCategory drops the id from EVERY budget window, skips windows lacking it, and survives an in-flight (undefined) window', async () => {
  // The Record-key drop must run per ['budgets', *] window: remove the id where present,
  // leave windows that never had it untouched (the `id in prev` guard), and not throw on a
  // still-loading window whose data is undefined (the `!prev` guard). A regression to array
  // `.filter` would throw on the first Record and abort the whole cascade.
  const result = await mount();
  queryClient.setQueryData<Category[]>(['categories'], [CAT, OTHER]);
  queryClient.setQueryData<Record<string, BudgetRollup>>(['budgets', 14], { coffee: { target: 100, posted: 40, pending: 10 }, rent: { target: 500, posted: 0, pending: 0 } });
  queryClient.setQueryData<Record<string, BudgetRollup>>(['budgets', 30], { rent: { target: 500, posted: 0, pending: 0 } }); // coffee absent here
  queryClient.setQueryData<Record<string, BudgetRollup> | undefined>(['budgets', 7], undefined); // an in-flight window

  await act(async () => { await result.current.deleteCategory('coffee'); });

  expect(queryClient.getQueryData<Record<string, BudgetRollup>>(['budgets', 14])).toEqual({ rent: { target: 500, posted: 0, pending: 0 } }); // coffee dropped
  expect(queryClient.getQueryData<Record<string, BudgetRollup>>(['budgets', 30])).toEqual({ rent: { target: 500, posted: 0, pending: 0 } }); // untouched (id absent)
  // The whole cascade ran (didn't abort on any window) — the category is gone and delete succeeded.
  expect(queryClient.getQueryData<Category[]>(['categories'])).toEqual([OTHER]);
});
