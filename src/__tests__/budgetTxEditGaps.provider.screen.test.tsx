// Transaction-detail resolver fix — ADVERSARIAL gaps for applyTransactionEdit's scoped-cache
// fallback + patch (src/context.tsx). Does NOT duplicate budgetTxOptimistic.provider.screen.test.tsx
// ([G4] note edit on budget list + rollback, [G4b] tag edit on category-drill + rollback, [G4c] note
// on a budget-ONLY row is applied). The gaps here:
//   [E1] a TAG edit (not note) on a budget-ONLY row round-trips into the budget list on SUCCESS.
//   [E2] the EXCLUDE path finds a budget-ONLY row via the fallback and shrinks the budget list.
//   [E3] a single note edit patches BOTH a budget cache AND a category cache, and rolls both back.
//   [E4] excluding a charge that lives ONLY in a category-drill cache MARKS it (budget_excluded)
//        there so the detail toggle moves and the screen keeps showing it — the qa-found bug.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CATS: Category[] = [
  { id: 'food', name: 'Food', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 0, parent: null },
  { id: 'coffee', name: 'Coffee', bucket: 'Living', icon: 'cup', color: '#7fd49b', recent: 0, parent: 'food' },
  { id: 'insurance', name: 'Insurance', bucket: 'Living', icon: 'shield', color: '#8ab4f8', recent: 0, parent: null },
];
const txn = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'CAFE', merchant_name: 'Cafe', amount: -6, account_id: 'a1',
  account_name: 'ANZ', category: 'coffee', status: 'posted', type: 'PAYMENT', counts_to_budget: true, ...over,
});
const budgetList = (id: string) => queryClient.getQueryData<Transaction[]>(['budgetTransactions', id]);

beforeEach(() => { mockStatus = 'authed'; queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount(feed: Transaction[]) {
  seedTransactionsCache(queryClient, feed);
  queryClient.setQueryData(['categories'], CATS);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

describe('[E] applyTransactionEdit — scoped-cache fallback + patch gaps', () => {
  // [E1] A TAG edit (the row-editor's other write, alongside notes) on a charge present ONLY in a
  // budget list must land the tag in that list. FAIL-ON-REVERT: reverting context.tsx removes the
  // findInScopedLists fallback → the edit early-returns → the tag never lands.
  it('[E1] a tag edit on a budget-only row lands in the budget list', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'bill', tags: ['work'] });
    const result = mount([]); // feed + recent empty
    queryClient.setQueryData(['budgetTransactions', 'insurance'], [txn('bill')]);

    await act(async () => { await result.current.applyTransactionEdit('bill', { tags: ['work'] }); });

    expect(budgetList('insurance')).toEqual([txn('bill', { tags: ['work'] })]);
  });

  // [E2] The EXCLUDE path on a budget-ONLY row (absent from feed/recent). The fallback must find it
  // so the budget_excluded stamp fires and the row is MARKED in the budget list (WHIT-525).
  // Every existing exclude test also seeds the feed, so this is the only guard on the fallback arm
  // of the exclude path. FAIL-ON-REVERT: reverting context.tsx → readTransactionsCache is empty and
  // there is no fallback → early return → stamp never runs → the row stays unmarked.
  it('[E2] excluding a budget-only row (feed empty) marks it in the budget list', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'bill', budget_excluded: true });
    const result = mount([]); // feed + recent empty
    queryClient.setQueryData(['budgetTransactions', 'insurance'], [txn('bill'), txn('other')]);

    await act(async () => { await result.current.applyTransactionEdit('bill', { budget_excluded: true }); });

    expect(budgetList('insurance')).toEqual([txn('bill', { budget_excluded: true }), txn('other')]);
  });

  // [E3] One note edit must patch BOTH scoped caches (budget + category) in a single call, then roll
  // BOTH back on a failed save. G4/G4b prove each cache alone; this proves patchScopedLists spans the
  // two prefixes in one edit and its rollback restores both. FAIL-ON-REVERT: reverting context.tsx
  // removes patchScopedLists → neither cache shows the optimistic note.
  it('[E3] a note edit patches both a budget and a category cache, and rolls back both on failure', async () => {
    let rejectSave: (e: unknown) => void = () => {};
    mockApi.setTransactionFields.mockReturnValue(new Promise((_res, rej) => { rejectSave = rej; }));
    const result = mount([txn('bill')]); // also in feed, so `previous` snapshots cleanly
    const drillKey = ['categoryTransactions', 'coffee', 0];
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('bill')]);
    queryClient.setQueryData(drillKey, [txn('bill')]);

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyTransactionEdit('bill', { notes: 'annual premium' }); });
    // Optimistic: BOTH scoped caches carry the new note before the save settles.
    expect(budgetList('food')).toEqual([txn('bill', { notes: 'annual premium' })]);
    expect(queryClient.getQueryData(drillKey)).toEqual([txn('bill', { notes: 'annual premium' })]);

    await act(async () => { rejectSave(new Error('network')); await pending; });
    // Rolled back: both restored to the original row, no stale note left behind.
    expect(budgetList('food')).toEqual([txn('bill')]);
    expect(queryClient.getQueryData(drillKey)).toEqual([txn('bill')]);
  });

  // [E5] WHIT-525 regression: a charge living ONLY in a budget list is excluded → the row must stay
  // findable (stamped budget_excluded:true in the budget cache). Before the fix, the row was removed
  // from the budget cache, making it unfindable and blanking the detail screen to "not found."
  // FAIL-ON-REVERT: reverting WHIT-525 removes the row from the budget cache → findInScopedLists
  // returns undefined → the detail screen flashes "Transaction not found."
  it('[E5] WHIT-525: excluding a budget-only row keeps it findable in the cache', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'bill', budget_excluded: true });
    const result = mount([]); // feed empty — the row lives ONLY in the budget cache
    queryClient.setQueryData(['budgetTransactions', 'insurance'], [txn('bill')]);

    await act(async () => { await result.current.applyTransactionEdit('bill', { budget_excluded: true }); });

    // The row is still in the budget cache, marked excluded — the detail screen can find it.
    expect(budgetList('insurance')).toEqual([txn('bill', { budget_excluded: true })]);
  });

  // [E4] Excluding a charge that lives ONLY in an Insights category-drill cache. The category cache
  // is MARKED (budget_excluded: true) in place, so the detail screen's toggle moves and the screen
  // keeps showing the row instead of blanking to "not found".
  // FAIL-ON-REVERT: reverting the category-mark arm leaves the row's
  // budget_excluded false → the toggle would never move. Rollback restores it on a failed save.
  it('[E4] excluding a category-only row marks it in place (toggle moves), and rolls back on failure', async () => {
    let rejectSave: (e: unknown) => void = () => {};
    mockApi.setTransactionFields.mockReturnValue(new Promise((_res, rej) => { rejectSave = rej; }));
    const result = mount([]); // feed + recent empty; the row lives ONLY in a category cache
    const drillKey = ['categoryTransactions', 'coffee', 0];
    queryClient.setQueryData(drillKey, [txn('bill')]);

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyTransactionEdit('bill', { budget_excluded: true }); });
    // Optimistic: the row stays in the category cache, now marked excluded (kept, not removed).
    expect(queryClient.getQueryData(drillKey)).toEqual([txn('bill', { budget_excluded: true })]);

    await act(async () => { rejectSave(new Error('network')); await pending; });
    // Rolled back to the original unmarked row.
    expect(queryClient.getQueryData(drillKey)).toEqual([txn('bill')]);
  });
});
