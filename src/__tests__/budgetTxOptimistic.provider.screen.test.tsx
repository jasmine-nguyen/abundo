// WHIT-344 — the OPTIMISTIC removal that makes a budget-detail row vanish the instant a charge
// is excluded, instead of only when the invalidate's refetch lands. Drives the REAL action
// through AppProvider (../api + ../auth mocked). The sibling budgetTxInvalidation suite proves
// the invalidate keys fire; these prove the synchronous ['budgetTransactions', *] setQueryData
// patch + its rollback. Removal only — re-including relies on the invalidate (no optimistic add).
// WHIT-459 — provider-family cluster fold. The five sibling suites (budgetTxInvalidation,
// budgetTxOptimisticSignOut, budgetTxRefileOptimistic, budgetTxRefileParentSubtree,
// budgetTxRefileSignOut) merged in below as block-scoped child describes, each keeping its own
// fixtures byte-for-byte. Shared harness (imports, ../api automock, wrapper, deferred/signOut,
// module beforeEach/afterEach) hoisted once. The ../auth mock is reconciled to the LIVE-store
// SUPERSET so the sign-out siblings can flip mockStatus; every other describe simply stays 'authed'.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category, Rule } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';

// Live auth store (superset). The static-'authed' siblings never touch mockStatus, so it stays
// 'authed' for them; the two sign-out siblings mutate it via mockSetStatus to drive sign-out.
let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: (l: () => void) => mockSubscribe(l) }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// Shared by the two sign-out siblings (byte-identical in both originals).
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function signOut() { act(() => { queryClient.clear(); mockSetStatus('anon'); }); }

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

beforeEach(() => {
  mockStatus = 'authed'; mockListeners.clear();
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); }); // clear the singleton's gcTime timers

function mount(transactions: Transaction[] = [txn()]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// [O-exclude-sync] excluding a charge removes it from the cached budget-detail list SYNCHRONOUSLY,
// before the server call resolves. FAIL-ON-REVERT: deleting the budgetTxSnapshots removal loop
// leaves 't1' in the list here (the invalidate alone can't drop it until a refetch lands).
it('exclude removes the row from the cached budget list before the server confirms', async () => {
  let resolveSave: (v: { transaction_id: string; budget_excluded: boolean }) => void = () => {};
  mockApi.setTransactionFields.mockReturnValue(new Promise((r) => { resolveSave = r; }));
  const result = mount();
  queryClient.setQueryData(['budgetTransactions', 'groceries'], [txn()]);

  let pending: Promise<void> = Promise.resolve();
  act(() => { pending = result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  // The optimistic patch ran synchronously; the save promise is still pending (unresolved).
  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual([]);

  await act(async () => { resolveSave({ transaction_id: 't1', budget_excluded: true }); await pending; });
});

// [O-exclude-all-entries] a charge on a child category also shows in a budgeted parent's list, so
// exclude must drop it from EVERY cached ['budgetTransactions', *] entry.
it('exclude removes the row from every cached budget list (parent + child)', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true });
  const result = mount();
  queryClient.setQueryData(['budgetTransactions', 'groceries'], [txn()]);
  queryClient.setQueryData(['budgetTransactions', 'food'], [txn()]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual([]);
  expect(queryClient.getQueryData(['budgetTransactions', 'food'])).toEqual([]);
});

// [O-rollback] a failed save restores the whole cached list in its original newest-first order.
// FAIL-ON-REVERT: rolling back by re-inserting individual rows (instead of restoring the snapshot)
// would not guarantee this exact order; dropping the catch restore leaves the row missing.
it('rolls back the removal (in original order) when the save fails', async () => {
  mockApi.setTransactionFields.mockRejectedValue(new Error('network'));
  const result = mount([txn(), txn({ transaction_id: 't2', date: '2026-06-20' })]);
  const original = [txn(), txn({ transaction_id: 't2', date: '2026-06-20' })];
  queryClient.setQueryData(['budgetTransactions', 'groceries'], original);

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual(original);
});

// [O-no-add] re-including a charge (budget_excluded: false) must NOT optimistically add a row —
// that needs the server's window + newest-first sort, so it's left to the invalidate/refetch.
it('re-include does NOT optimistically add a row to the cached budget list', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: false });
  const result = mount();
  queryClient.setQueryData(['budgetTransactions', 'groceries'], []);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: false }); });

  // No phantom insert...
  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual([]);
  // ...but the invalidate still fires so a refetch adds it back with the right window/sort.
  const keys = spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toContain('budgetTransactions');
  spy.mockRestore();
});

// [O-cold-cache] with no budget list cached (evicted / never opened), the patch no-ops cleanly.
it('exclude no-ops when no budget list is cached', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true });
  const result = mount();

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toBeUndefined();
});

// [WHIT-360] a failed exclude rollback restores ONLY the shrunk list, never an unrelated list that
// was refetched mid-save. groceries holds t1; the 'food' list never held it, so excluding t1 shrinks
// only groceries. While the save is pending a background refetch replaces food's list; on failure the
// rollback must restore groceries but NOT clobber food's fresh data. FAIL-ON-REVERT: restoring ALL
// snapshots (the old behaviour) stamps food back to its stale pre-save value.
it('[WHIT-360] exclude rollback restores only the shrunk list, not an unrelated refetched list', async () => {
  let rejectSave: (e: unknown) => void = () => {};
  mockApi.setTransactionFields.mockReturnValue(new Promise((_res, rej) => { rejectSave = rej; }));
  const result = mount();
  queryClient.setQueryData(['budgetTransactions', 'groceries'], [txn()]);
  queryClient.setQueryData(['budgetTransactions', 'food'], [txn({ transaction_id: 't9old' })]); // never holds t1

  let pending: Promise<void> = Promise.resolve();
  act(() => { pending = result.current.applyTransactionEdit('t1', { budget_excluded: true }); });
  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual([]); // shrank; food untouched

  // A background refetch of the unrelated 'food' list lands while the save is still pending.
  act(() => { queryClient.setQueryData(['budgetTransactions', 'food'], [txn({ transaction_id: 't9new' })]); });

  await act(async () => { rejectSave(new Error('network')); await pending; });

  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual([txn()]);                    // shrunk list restored
  expect(queryClient.getQueryData(['budgetTransactions', 'food'])).toEqual([txn({ transaction_id: 't9new' })]); // fresh data NOT clobbered
});

// ===== WHIT-344 (folded from budgetTxOptimisticGaps.provider.screen.test.tsx)
// ADVERSARIAL gaps around the optimistic ['budgetTransactions', *] removal in applyTransactionEdit:
// [G1] siblings untouched, [G2] a list without the id is preserved, [G3] rollback restores MULTIPLE
// cached entries, [G4] the ['transactions'] row survives the exclude (it is patched, not dropped).

// [G1] (P0) A budget list holds several charges; excluding ONE drops only that row and leaves the
// others in their original newest-first order. FAIL-ON-REVERT: neutralising the removal filter to a
// no-op leaves t1 present, so this reddens.
it('exclude removes ONLY the excluded row, leaving siblings intact and ordered', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true } as never);
  const t1 = txn();
  const t2 = txn({ transaction_id: 't2', date: '2026-06-28', description: 'WOOLIES' });
  const t3 = txn({ transaction_id: 't3', date: '2026-06-20', description: 'ALDI' });
  const result = mount([t1, t2, t3]);
  queryClient.setQueryData(['budgetTransactions', 'groceries'], [t1, t2, t3]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual([t2, t3]);
});

// [G2] (P1) A cached budget list that does NOT contain the excluded id must keep every row it holds
// (the removal touches every ['budgetTransactions', *] entry; a list without the id must be a no-op
// on contents). FAIL-ON-REVERT covered by [G1]; this pins the "don't drop the wrong row" direction.
it('a budget list without the excluded id keeps all its rows', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true } as never);
  const other1 = txn({ transaction_id: 'x1', category: 'transport' });
  const other2 = txn({ transaction_id: 'x2', category: 'transport', date: '2026-06-15' });
  const result = mount([txn(), other1, other2]);
  queryClient.setQueryData(['budgetTransactions', 'transport'], [other1, other2]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(queryClient.getQueryData(['budgetTransactions', 'transport'])).toEqual([other1, other2]);
});

// [G3] (P0) A failed save restores EVERY snapshotted list, not just the first. The implementer's
// [O-rollback] proves one list; this proves the forEach restore covers multiple entries.
// FAIL-ON-REVERT: deleting the catch restore line leaves both lists emptied → reddens.
it('rolls back every cached budget list when the save fails', async () => {
  mockApi.setTransactionFields.mockRejectedValue(new Error('network'));
  const parent = [txn(), txn({ transaction_id: 't2', date: '2026-06-20' })];
  const child = [txn()];
  const result = mount([txn(), txn({ transaction_id: 't2', date: '2026-06-20' })]);
  queryClient.setQueryData(['budgetTransactions', 'food'], parent);
  queryClient.setQueryData(['budgetTransactions', 'groceries'], child);

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(queryClient.getQueryData(['budgetTransactions', 'food'])).toEqual(parent);
  expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toEqual(child);
});

// [G4] (P0) The exclude must PATCH the ['transactions'] row (budget_excluded:true) and keep it in
// the list — the detail screen still shows the charge; only budgets drop it. Guards against the
// removal logic ever bleeding into the transactions cache. FAIL-ON-REVERT: if patchTransactions
// stopped setting budget_excluded, the flag assertion reddens.
it('exclude keeps the charge in the transactions cache, flagged excluded', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true } as never);
  const result = mount([txn(), txn({ transaction_id: 't2' })]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  const list = readTransactionsCache(queryClient);
  const row = list.find((t) => t.transaction_id === 't1');
  expect(list).toHaveLength(2);            // NOT removed from the transactions list
  expect(row?.budget_excluded).toBe(true); // flagged for the detail screen
});

// ===== WHIT-344 QA-gap invalidation (folded from budgetTxInvalidation.provider.screen.test.tsx)
// The ['budgetTransactions'] cache invalidations that keep the budget-detail list reconciled with
// its header after a write. NB this suite's `txn` defaults to category:null (an unmapped charge) so
// the applyCategory('one') re-tag is a real move, not a no-op — kept block-scoped below.
describe('budgetTxInvalidation (folded)', () => {
  const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
  const txn = (over: Partial<Transaction> = {}): Transaction => ({
    transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
    description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
    account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
    ...over,
  });

  // The [0] element of every invalidateQueries call — the top-level query key.
  function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
    return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
  }

  beforeEach(() => {
    queryClient.clear();
    mockApi.createEnrichment.mockResolvedValue({ id: 'r1', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' });
    mockApi.setTransactionCategory.mockResolvedValue({ transaction_id: 't1', category: 'groceries' });
  });
  afterEach(() => { queryClient.clear(); jest.restoreAllMocks(); }); // clear the singleton + restore spies (config has clearMocks, not restoreMocks)

  function mount(transactions: Transaction[] = [txn()]) {
    seedTransactionsCache(queryClient, transactions);
    queryClient.setQueryData(['categories'], [{ ...CAT }]);
    queryClient.setQueryData(['budgets', 14], {});
    const { result } = renderHook(() => useAppContext(), { wrapper });
    return result;
  }

  // [A-inval-exclude] excluding a charge must refresh the budget-detail LIST too, so the header
  // (which now drops it) and the rows below it stay reconciled. FAIL-ON-REVERT: removing the
  // `if ('budget_excluded' in patch)` invalidation block drops 'budgetTransactions' here.
  it('applyTransactionEdit(budget_excluded) invalidates budgets/breakdown/budgetTransactions', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true });
    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'budgetTransactions']));
    expect(invalidatedKeys(spy)).not.toContain('transactions'); // feed patched in place, never invalidated
    spy.mockRestore();
  });

  // [A-inval-guard] a note edit changes NEITHER the total nor the cycle list, so it must NOT
  // invalidate the budget lists (that would refetch every open budget for a cosmetic note) — and
  // it must NOT invalidate the feed (patched in place). FAIL-ON-REVERT: hoisting the budget
  // invalidations out of the `budget_excluded` guard makes a note edit invalidate 'budgetTransactions'.
  it('applyTransactionEdit(notes) invalidates NOTHING — not the feed, not the budget lists', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', notes: 'lunch' });
    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch' }); });

    const keys = invalidatedKeys(spy);
    expect(keys).not.toContain('transactions');
    expect(keys).not.toContain('budgetTransactions');
    expect(keys).not.toContain('budgets');
    expect(keys).toHaveLength(0); // a plain note edit invalidates no cache at all
    spy.mockRestore();
  });

  // [A-inval-categorise-one] re-tagging a charge moves it between budgets' cycle lists, so the
  // budget-detail lists must refresh. FAIL-ON-REVERT: dropping the ['budgetTransactions'] line in
  // invalidateAfterCategorise makes this key absent.
  it('applyCategory(one) invalidates budgetTransactions alongside budgets/breakdown', async () => {
    const result = mount();
    act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.applyCategory('one'); });

    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'budgetTransactions']));
    expect(invalidatedKeys(spy)).not.toContain('transactions'); // feed patched in place, never invalidated
    spy.mockRestore();
  });
});

// ===== WHIT-344 / WHIT-271 (folded from budgetTxOptimisticSignOut.provider.screen.test.tsx)
// The optimistic budget-list rollback in applyTransactionEdit is the only rollback writer that is
// neither epoch-guarded nor cache-existence-guarded; this pins the WHIT-271 invariant that a writer
// settling after sign-out re-seats nothing. Uses the module-level (groceries) `txn` (byte-identical
// to this suite's original) and the shared live auth store / deferred / signOut.
describe('WHIT-344 exclude rollback settling after sign-out', () => {
  it('does NOT re-seat the old account budget list into the cleared cache', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    queryClient.setQueryData(['budgetTransactions', 'groceries'], [txn()]);
    const d = deferred<{ transaction_id: string; budget_excluded: boolean }>();
    mockApi.setTransactionFields.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyTransactionEdit('t1', { budget_excluded: true }); });
    signOut(); // cache cleared, epoch bumped, while the save is still in-flight
    await act(async () => { d.reject(new Error('network')); await pending; });

    // WHIT-271 invariant: nothing from the prior session may reappear in the wiped cache.
    expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toBeUndefined();
  });
});

// ===== WHIT-348 / WHIT-360 (folded from budgetTxRefileOptimistic.provider.screen.test.tsx)
// The optimistic removal that makes a re-filed charge vanish from a budget-detail list the instant
// it is re-filed OUT of that budget's subtree, plus the WHIT-360 narrowed-rollback adversarial gaps.
// This suite's `txn(id, over)` (id-first, category:'coffee') and CATS subtree are block-scoped here.
describe('budgetTxRefileOptimistic (folded)', () => {
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
});

// ===== WHIT-348 (folded from budgetTxRefileParentSubtree.provider.screen.test.tsx)
// Adversarial gaps for the optimistic budget-list removal on re-file: parent-keep, overlapping
// budgets, all-multi sweep, and the no-op setQueryData-spy assertion. This suite's deeper CATS tree
// (food→dining→coffee, food→snacks) and `txn(id, over)` / `list` helper are block-scoped here.
describe('budgetTxRefileParentSubtree (folded)', () => {
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
  afterEach(() => { queryClient.clear(); jest.restoreAllMocks(); }); // clear the singleton + restore the [NOOP] setQueryData spy

  function mount(transactions: Transaction[]) {
    seedTransactionsCache(queryClient, transactions);
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
});

// ===== WHIT-348 / WHIT-271 (folded from budgetTxRefileSignOut.provider.screen.test.tsx)
// The NEW budget-list rollback for the re-file paths uses a raw, epoch-gated setQueryData; a re-file
// save that FAILS after sign-out must not re-seat the prior account's budget list into the freshly
// cleared cache. Block-scoped CATS (food→coffee, transport) + `txn(over)` (category:'coffee').
describe('WHIT-348 re-file budget-list rollback settling after sign-out', () => {
  // food(Living) → coffee(Living); transport(Living) is outside food. A coffee charge sits in food's
  // budget list; re-filing to transport re-files it OUT of food (optimistic drop).
  const CATS: Category[] = [
    { id: 'food', name: 'Food', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 0, parent: null },
    { id: 'coffee', name: 'Coffee', bucket: 'Living', icon: 'cup', color: '#7fd49b', recent: 0, parent: 'food' },
    { id: 'transport', name: 'Transport', bucket: 'Living', icon: 'car', color: '#8ab4f8', recent: 0, parent: null },
  ];

  const txn = (over: Partial<Transaction> = {}): Transaction => ({
    transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
    description: 'CAFE', merchant_name: 'Cafe', amount: -6, account_id: 'a1',
    account_name: 'ANZ', category: 'coffee', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
    ...over,
  });

  it('does NOT re-seat the old account budget list into the cleared cache', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    queryClient.setQueryData(['categories'], CATS);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn()]);
    const d = deferred<{ results: { id: string; status: 'updated' }[] }>();
    mockApi.setTransactionCategories.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    // Optimistic removal drops t1 from food's list synchronously here.
    act(() => { pending = result.current.applyCategoryToMany(['t1'], 'transport'); });
    expect(queryClient.getQueryData(['budgetTransactions', 'food'])).toEqual([]); // dropped optimistically

    signOut(); // cache cleared + epoch bumped, save still in flight
    await act(async () => { d.reject(new Error('network')); await pending; });

    // WHIT-271 invariant: the failed re-file's restore must NOT resurrect the prior session's list.
    expect(queryClient.getQueryData(['budgetTransactions', 'food'])).toBeUndefined();
  });
});
