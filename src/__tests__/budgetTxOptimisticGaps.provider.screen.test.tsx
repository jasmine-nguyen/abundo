// WHIT-344 — ADVERSARIAL gaps around the optimistic ['budgetTransactions', *] removal in
// applyTransactionEdit. Complements budgetTxOptimistic.provider.screen.test.tsx (implementer's
// happy path). Covers: [G1] siblings untouched, [G2] a list without the id is preserved,
// [G3] rollback restores MULTIPLE cached entries, [G4] the ['transactions'] row survives the
// exclude (it is patched, not dropped). Same harness/style as the implementer's suite.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
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

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount(transactions: Transaction[]) {
  queryClient.setQueryData(['transactions'], transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }]);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

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

  const list = queryClient.getQueryData<Transaction[]>(['transactions'])!;
  const row = list.find((t) => t.transaction_id === 't1');
  expect(list).toHaveLength(2);            // NOT removed from the transactions list
  expect(row?.budget_excluded).toBe(true); // flagged for the detail screen
});
