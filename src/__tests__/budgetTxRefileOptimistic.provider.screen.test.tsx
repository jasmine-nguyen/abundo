// WHIT-348 — the OPTIMISTIC removal that makes a re-filed charge vanish from a budget-detail list
// the instant it's re-filed OUT of that budget's subtree, instead of only when the invalidate's
// refetch lands (mirroring WHIT-344's exclude removal, for the three re-categorise write paths).
// Drives the REAL applyCategory('one'/'all') + applyCategoryToMany through AppProvider (../api +
// ../auth mocked) and asserts the synchronous ['budgetTransactions', budgetId] setQueryData patch,
// its rollback, and that a re-file that STAYS in the subtree — or a list that never held the row —
// is left untouched. budgetSubtreeContains parity vs the server rule lives in budgetSubtreeParity.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category, Rule } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// food(Living) → coffee(Living); transport(Living) and shopping(Living) are separate top-level
// budgets. A charge on `coffee` sits in food's budget list; re-filing it to `transport` re-files
// it OUT of food's subtree (should drop), while re-filing to `coffee`/`food` stays in (should keep).
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

const foodList = () => queryClient.getQueryData<Transaction[]>(['budgetTransactions', 'food']);
const budgetList = (id: string) => queryClient.getQueryData<Transaction[]>(['budgetTransactions', id]);

beforeEach(() => {
  queryClient.clear();
  mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'transport' });
  mockApi.setTransactionCategories.mockImplementation(async (updates: { id: string; category: string }[]) =>
    ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) }));
  mockApi.createEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'CAFE', categoryId: 'transport' });
});
afterEach(() => { queryClient.clear(); }); // clear the singleton's gcTime timers

function mount(transactions: Transaction[]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], CATS);
  queryClient.setQueryData(['budgets', 14], {});
  queryClient.setQueryData<Rule[]>(['rules'], []);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

describe('WHIT-348 optimistic removal on re-file', () => {
  it("applyCategory('one') re-filed OUT of a budget drops the row; an unrelated budget list is untouched", async () => {
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('t9', { category: 'shopping' })]); // never held t1

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    await act(async () => { await result.current.applyCategory('one'); });

    expect(foodList()).toEqual([]);                                   // re-filed out of food → dropped
    expect(budgetList('shopping')).toEqual([txn('t9', { category: 'shopping' })]); // no-op on a list it was never in
  });

  it("applyCategory('one') re-filed to a category STILL in the budget subtree keeps the row", async () => {
    // t1 is on 'coffee'; re-file to 'food' (the budget itself) — still inside food's subtree.
    mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'food' });
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'food' }));
    await act(async () => { await result.current.applyCategory('one'); });

    expect(foodList()).toEqual([txn('t1')]);                         // stays in food's subtree → kept
  });

  it("applyCategory('one') restores the row when the save fails", async () => {
    mockApi.setTransactionCategory.mockRejectedValue(new Error('boom'));
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    await act(async () => { await result.current.applyCategory('one'); });

    expect(foodList()).toEqual([txn('t1')]);                         // failed save → optimistic removal rolled back
  });

  it("applyCategory('all') re-filed OUT drops the row from the budget list", async () => {
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);

    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    await act(async () => { await result.current.applyCategory('all'); });

    expect(foodList()).toEqual([]);
  });

  it('applyCategoryToMany re-filed OUT drops exactly those rows', async () => {
    const result = mount([txn('t1'), txn('t2')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1'), txn('t2')]);

    await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'transport'); });

    expect(foodList()).toEqual([]);
  });

  it('applyCategoryToMany partial failure restores ONLY the failed row (Decision A)', async () => {
    // t1 saves, t2 fails → t2 reappears in the food list, t1 stays gone.
    mockApi.setTransactionCategories.mockResolvedValue({ results: [{ id: 't1', status: 'updated' as const }] });
    const result = mount([txn('t1'), txn('t2')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1'), txn('t2')]);

    await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'transport'); });

    expect(foodList()).toEqual([txn('t2')]);                         // saved t1 stays removed; failed t2 restored
  });

  it('[WHIT-360] a failed rollback restores ONLY the shrunk list, never an unrelated list refetched mid-save', async () => {
    // food holds t1; shopping never held it. Re-file t1 OUT of food → only food shrinks. While the
    // save is in flight, a background refetch replaces shopping's list with fresh data. When the save
    // FAILS, the rollback must restore food (the shrunk list) but must NOT clobber shopping's fresh
    // data with the stale pre-save snapshot. Fail-on-revert: restoring ALL snapshots (the old
    // behaviour) stamps shopping back to [t9old].
    let rejectSave: (e: unknown) => void = () => {};
    mockApi.setTransactionCategory.mockReturnValue(new Promise((_res, rej) => { rejectSave = rej; }));
    const result = mount([txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('t1')]);
    queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('t9old', { category: 'shopping' })]);

    // setSheet in its own act so applyCategory's callback re-renders with the confirm sheet in scope.
    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'transport' }));
    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyCategory('one'); });
    expect(foodList()).toEqual([]); // food shrank optimistically; shopping was never touched

    // A background refetch of the UNRELATED shopping list lands while the save is still pending.
    act(() => { queryClient.setQueryData(['budgetTransactions', 'shopping'], [txn('t9new', { category: 'shopping' })]); });

    await act(async () => { rejectSave(new Error('boom')); await pending; });

    expect(foodList()).toEqual([txn('t1')]);                                    // shrunk list correctly restored
    expect(budgetList('shopping')).toEqual([txn('t9new', { category: 'shopping' })]); // fresh data NOT clobbered
  });
});

// ===== WHIT-360 (folded from budgetTxRestoreNarrowingGaps.provider.screen.test.tsx)
// ADVERSARIAL gaps around the NARROWED optimistic-removal rollback: on a failed save the rollback
// must restore ONLY the budget-detail lists the removal actually shrank, never re-stamp an unrelated
// ['budgetTransactions', *] list refetched mid-save. Covers batch partial-failure + unrelated
// refetch, a setQueryData spy, parent+child restore, the exclude-path note-only guard, and an
// empty-then-refetched list. Reuses this file's CATS / txn / budgetList / foodList (byte-identical).
// The outer describe carries its OWN afterEach(jest.restoreAllMocks) so the [G2]/[G4] spies can't
// leak (jest.config has clearMocks but NOT restoreMocks); the module-level afterEach still clears
// the queryClient.
describe('WHIT-360 narrowed rollback (folded gaps)', () => {
  afterEach(() => { jest.restoreAllMocks(); }); // restore any spies even if an assertion threw

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
});
