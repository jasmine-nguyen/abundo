// WHIT-348 — adversarial gaps for the optimistic budget-list removal on re-file, beyond the
// implementer's budgetTxRefileOptimistic.provider.screen.test.tsx. Covers, through the REAL
// applyCategory('one'/'all') + applyCategoryToMany on AppProvider:
//   [PARENT-KEEP] a charge on a leaf under a budgeted PARENT, re-filed to a SIBLING still under the
//                 parent → the parent-budget list KEEPS the row (subtree still owns it).
//   [OVERLAP]     two OVERLAPPING same-bucket budgets (grandparent + parent) both listing the shared
//                 descendant → re-filing to a category under only ONE drops it from the OTHER's list
//                 but not the one that still owns it (per-list independence).
//   [ALL-MULTI]   applyCategory('all') sweeping MULTIPLE same-merchant ids → every id leaves the old
//                 list; on partial failure ONLY the failed id is restored (the 'all' path's re-drop,
//                 distinct from applyCategoryToMany's which the implementer already covered).
//   [NOOP]        a list the removal doesn't change (still-owned, or never held the row) is NOT
//                 rewritten — proven by spying on setQueryData (React Query's structural sharing
//                 makes a deep-equal write a reference no-op, so identity alone can't prove the skip).
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category, Rule } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// food(Living) → dining(Living) → coffee(Living); food → snacks(Living). transport(Living) and
// shopping(Living) are unrelated top-level budgets. A charge on `coffee` sits under BOTH the
// grandparent `food` and the parent `dining`. `snacks` is under food but NOT under dining.
const CATS: Category[] = [
  { id: 'food', name: 'Food', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 0, parent: null },
  { id: 'dining', name: 'Dining', bucket: 'Living', icon: 'plate', color: '#7fd49b', recent: 0, parent: 'food' },
  { id: 'coffee', name: 'Coffee', bucket: 'Living', icon: 'cup', color: '#7fd49b', recent: 0, parent: 'dining' },
  { id: 'snacks', name: 'Snacks', bucket: 'Living', icon: 'candy', color: '#7fd49b', recent: 0, parent: 'food' },
  { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
  { id: 'shopping', name: 'Shopping', bucket: 'Living', icon: 'bag', color: '#f0b27a', recent: 0, parent: null },
];

const txn = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'CAFE', merchant_name: 'Cafe', amount: -6, account_id: 'a1',
  account_name: 'ANZ', category: 'coffee', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

const list = (id: string) => queryClient.getQueryData<Transaction[]>(['budgetTransactions', id]);

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'transport' });
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) =>
    ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'CAFE', categoryId: 'transport' });
});
afterEach(() => { queryClient.clear(); });

function mount(transactions: Transaction[]) {
  queryClient.setQueryData(['transactions'], transactions);
  queryClient.setQueryData(['categories'], CATS);
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData<Rule[]>(['rules'], []);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

describe('WHIT-348 optimistic removal — parent/overlap/all-multi/no-op gaps', () => {
  it('[OVERLAP+PARENT-KEEP] re-file leaf→sibling drops it from the parent budget but keeps it in the grandparent', async () => {
    mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'snacks' });
    const result = mount([txn('t1')]);
    // The same coffee charge is listed under BOTH budgeted ancestors.
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'dining'], [txn('t1')]);

    // snacks is under food (grandparent) but NOT under dining (parent).
    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'snacks' }));
    await act(async () => { await result.current.applyCategory('one'); });

    expect(list('food')).toEqual([txn('t1')]);   // still inside food's subtree → kept
    expect(list('dining')).toEqual([]);           // no longer inside dining's subtree → dropped
  });

  it('[OVERLAP] re-file OUT of the whole subtree drops the row from BOTH overlapping budget lists', async () => {
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'dining'], [txn('t1')]);

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    await act(async () => { await result.current.applyCategory('one'); });

    expect(list('food')).toEqual([]);
    expect(list('dining')).toEqual([]);
  });

  it('[NOOP] a still-owned list and a never-held list are not rewritten (no setQueryData for them)', async () => {
    // Re-file coffee → dining: dining is still under food (subtree still owns it), so food's list is
    // skipped by the ownership guard; shopping never held the charge, so it's skipped by the shrink
    // guard. React Query's structural sharing returns the OLD reference on a deep-equal write, so
    // reference identity can't distinguish "skipped" from "rewritten with equal data" — spy on
    // setQueryData and assert neither budget key was written during the re-file.
    mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'dining' });
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('t9', { category: 'shopping' })]);

    const setSpy = jest.spyOn(queryClient, 'setQueryData');
    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'dining' }));
    await act(async () => { await result.current.applyCategory('one'); });

    const budgetKeysWritten = setSpy.mock.calls
      .map((call) => call[0])
      .filter((key): key is unknown[] => Array.isArray(key) && key[0] === 'budgetTransactions')
      .map((key) => key[1]);
    expect(budgetKeysWritten).not.toContain('food');      // still-owned → ownership guard skips it
    expect(budgetKeysWritten).not.toContain('shopping');  // never held the row → shrink guard skips it
    setSpy.mockRestore();
  });

  it("[ALL-MULTI] applyCategory('all') removes EVERY swept id from the old budget list", async () => {
    // Two unmapped (category null) same-merchant charges → the sweep captures both. They are seeded
    // into food's list to exercise the multi-id removal keyed purely on transaction_id.
    const t1 = txn('t1', { category: null });
    const t2 = txn('t2', { category: null });
    const result = mount([t1, t2]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [t1, t2]);

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    await act(async () => { await result.current.applyCategory('all'); });

    expect(list('food')).toEqual([]); // both swept ids dropped from food
  });

  it("[ALL-MULTI] applyCategory('all') partial failure restores ONLY the failed id (the 'all' re-drop path)", async () => {
    // t1 saves, t2 fails → t2 reappears in food's list, t1 stays gone. Distinct code path from
    // applyCategoryToMany's partial-failure re-drop (context.tsx ~905 vs ~992).
    mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] });
    const t1 = txn('t1', { category: null });
    const t2 = txn('t2', { category: null });
    const result = mount([t1, t2]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [t1, t2]);

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    await act(async () => { await result.current.applyCategory('all'); });

    expect(list('food')).toEqual([t2]); // saved t1 stays removed; failed t2 restored
  });
});
