// WHIT-360 — ADVERSARIAL gaps around the NARROWED optimistic-removal rollback: on a failed save
// the rollback must restore ONLY the budget-detail lists the removal actually shrank, never
// re-stamp an unrelated ['budgetTransactions', *] list that was refetched mid-save (which would
// clobber fresh data with a stale snapshot). Covers the interactions the implementer's two
// single-id / full-fail tests DON'T: batch partial-failure + unrelated refetch, a setQueryData
// spy (stronger than value-equality, which structural sharing can mask), multiple shrunk lists
// (parent + child), the exclude-path note-only guard, and an empty-then-refetched list.
// Drives the REAL applyCategory / applyCategoryToMany / applyTransactionEdit through AppProvider.
//   [G1] batch partial-failure re-remove + unrelated refetch      (re-file path, Decision A)
//   [G2] rollback issues NO setQueryData to the unrelated key      (exclude path, spy)
//   [G3] parent + child both restored, unrelated untouched         (re-file path)
//   [G4] note-only edit never scans/snapshots the budget lists     (exclude guard preserved)
//   [G5] empty-at-removal list refetched into rows survives        (exclude path, second-bug guard)
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

// food(Living) → coffee(Living); transport + shopping are separate top-level budgets. A charge on
// `coffee` sits in BOTH food's and coffee's budget lists; re-filing it to `transport` re-files it
// OUT of both subtrees (both shrink). `shopping` never holds it (the unrelated list).
const CATS: Category[] = [
  { id: 'food', name: 'Food', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 0, parent: null },
  { id: 'coffee', name: 'Coffee', bucket: 'Living', icon: 'cup', color: '#7fd49b', recent: 0, parent: 'food' },
  { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
  { id: 'shopping', name: 'Shopping', bucket: 'Living', icon: 'bag', color: '#f0b27a', recent: 0, parent: null },
];

const txn = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'CAFE', merchant_name: 'Cafe', amount: -6, account_id: 'a1',
  account_name: 'ANZ', category: 'coffee', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

const budgetList = (id: string) => queryClient.getQueryData<Transaction[]>(['budgetTransactions', id]);
const foodList = () => budgetList('food');

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'transport' });
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) =>
    ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'CAFE', categoryId: 'transport' });
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true });
});
afterEach(() => { jest.restoreAllMocks(); queryClient.clear(); }); // restore any spies even if an assertion threw; clear gcTime timers

function mount(transactions: Transaction[]) {
  queryClient.setQueryData(['transactions'], transactions);
  queryClient.setQueryData(['categories'], CATS);
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData<Rule[]>(['rules'], []);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

describe('WHIT-360 re-file path — narrowed rollback', () => {
  it('[G1] batch partial-failure re-remove keeps the failed row, drops the saved row, and preserves an unrelated list refetched mid-save', async () => {
    // food holds t1 + t2; shopping never held either. Re-file [t1,t2] OUT of food; t1 SAVES, t2 FAILS.
    // Mid-save a background refetch replaces shopping's list. On partial failure the rollback must:
    // restore food, re-drop only the saved t1 (Decision A), and NEVER touch shopping's fresh data.
    let resolveBatch: (v: { results: { id: string; status: 'updated' }[] }) => void = () => {};
    mockApi.setTransactionCategories.mockReturnValue(
      new Promise((r) => { resolveBatch = r; }) as ReturnType<typeof api.setTransactionCategories>);
    const result = mount([txn('t1'), txn('t2')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1'), txn('t2')]);
    queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('s0', { category: 'shopping' })]);

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyCategoryToMany(['t1', 't2'], 'transport'); });
    expect(foodList()).toEqual([]); // both dropped optimistically; shopping untouched

    // A background refetch of the UNRELATED shopping list lands while the batch is still pending.
    act(() => { queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('s1new', { category: 'shopping' })]); });

    await act(async () => { resolveBatch({ results: [{ id: 't1', status: 'updated' }] }); await pending; });

    expect(foodList()).toEqual([txn('t2')]);                                        // failed t2 restored; saved t1 stays gone
    expect(budgetList('shopping')).toEqual([txn('s1new', { category: 'shopping' })]); // fresh data NOT clobbered
  });

  it('[G3] a failed re-file restores BOTH shrunk lists (parent + child) and leaves an unrelated refetched list untouched', async () => {
    // t1 is on coffee → held by food (parent) AND coffee (child). Re-file to transport (out of both).
    let rejectSave: (e: unknown) => void = () => {};
    mockApi.setTransactionCategory.mockReturnValue(
      new Promise((_res, rej) => { rejectSave = rej; }) as ReturnType<typeof api.setTransactionCategory>);
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'coffee'], [txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('s0', { category: 'shopping' })]);

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyCategory('one'); });
    expect(foodList()).toEqual([]);            // both shrank optimistically
    expect(budgetList('coffee')).toEqual([]);

    act(() => { queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('s1new', { category: 'shopping' })]); });

    await act(async () => { rejectSave(new Error('boom')); await pending; });

    expect(foodList()).toEqual([txn('t1')]);                                        // parent restored
    expect(budgetList('coffee')).toEqual([txn('t1')]);                              // child restored
    expect(budgetList('shopping')).toEqual([txn('s1new', { category: 'shopping' })]); // unrelated fresh data preserved
  });
});

describe('WHIT-360 exclude path — narrowed rollback', () => {
  it('[G2] a failed exclude rollback issues NO setQueryData write to an unrelated list refetched mid-save', async () => {
    // Stronger than value-equality (structural sharing can mask a re-write): assert the rollback
    // never even CALLS setQueryData for the unrelated key. Spy is installed AFTER the mid-save
    // refetch so the refetch's own write isn't counted.
    let rejectSave: (e: unknown) => void = () => {};
    mockApi.setTransactionFields.mockReturnValue(
      new Promise((_res, rej) => { rejectSave = rej; }) as ReturnType<typeof api.setTransactionFields>);
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);        // holds t1 → shrinks
    queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('s0', { category: 'shopping' })]); // never held t1

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyTransactionEdit('t1', { budget_excluded: true }); });
    expect(foodList()).toEqual([]);

    act(() => { queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('s1new', { category: 'shopping' })]); });

    const spy = jest.spyOn(queryClient, 'setQueryData');
    await act(async () => { rejectSave(new Error('boom')); await pending; });

    const shoppingWrites = spy.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[0]) && c[0][0] === 'budgetTransactions' && c[0][1] === 'shopping');
    expect(shoppingWrites).toEqual([]);                                             // rollback never wrote the unrelated key
    spy.mockRestore();
    expect(budgetList('shopping')).toEqual([txn('s1new', { category: 'shopping' })]); // and the fresh data survived
  });

  it('[G4] a note-only edit (budget_excluded absent) never scans or rewrites the budget lists', async () => {
    // The snapshot is guarded on `patch.budget_excluded === true`. A note/tag edit must NOT scan
    // (getQueriesData) or rewrite (setQueryData) any ['budgetTransactions', *] list — even on failure.
    mockApi.setTransactionFields.mockRejectedValue(new Error('boom'));
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);

    const getSpy = jest.spyOn(queryClient, 'getQueriesData');
    const setSpy = jest.spyOn(queryClient, 'setQueryData');
    await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch with A' }); });

    const budgetScans = getSpy.mock.calls.filter(
      (c: unknown[]) => (c[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0] === 'budgetTransactions');
    const budgetWrites = setSpy.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[0]) && c[0][0] === 'budgetTransactions');
    expect(budgetScans).toEqual([]);            // guard skipped the getQueriesData snapshot entirely
    expect(budgetWrites).toEqual([]);           // and never rewrote a budget list
    expect(foodList()).toEqual([txn('t1')]);    // the list is left exactly as-is
    getSpy.mockRestore(); setSpy.mockRestore();
  });

  it('[G5] a list that was EMPTY at removal time and refetched into rows mid-save survives a failed rollback', async () => {
    // The old code snapshotted EVERY present list (an empty [] included) and restored it verbatim,
    // erasing a mid-save refetch. The `data?.some(...)` filter drops the empty list from the snapshot
    // set, so it is never restored/erased.
    let rejectSave: (e: unknown) => void = () => {};
    mockApi.setTransactionFields.mockReturnValue(
      new Promise((_res, rej) => { rejectSave = rej; }) as ReturnType<typeof api.setTransactionFields>);
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);   // holds t1 → shrinks
    queryClient.setQueryData(['budgetTransactions', 'shopping'], []);         // present but EMPTY, never held t1

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyTransactionEdit('t1', { budget_excluded: true }); });
    expect(foodList()).toEqual([]);

    // shopping's refetch lands mid-save, now holding real rows.
    act(() => { queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('s1new', { category: 'shopping' })]); });

    await act(async () => { rejectSave(new Error('boom')); await pending; });

    expect(foodList()).toEqual([txn('t1')]);                                        // shrunk list restored
    expect(budgetList('shopping')).toEqual([txn('s1new', { category: 'shopping' })]); // empty→refetched list NOT erased
  });
});
