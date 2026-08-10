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
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';

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
