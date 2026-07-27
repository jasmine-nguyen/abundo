// WHIT-344 — the OPTIMISTIC removal that makes a budget-detail row vanish the instant a charge
// is excluded, instead of only when the invalidate's refetch lands. Drives the REAL action
// through AppProvider (../api + ../auth mocked). The sibling budgetTxInvalidation suite proves
// the invalidate keys fire; these prove the synchronous ['budgetTransactions', *] setQueryData
// patch + its rollback. Removal only — re-including relies on the invalidate (no optimistic add).
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

beforeEach(() => {
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); }); // clear the singleton's gcTime timers

function mount(transactions: Transaction[] = [txn()]) {
  queryClient.setQueryData(['transactions'], transactions);
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
