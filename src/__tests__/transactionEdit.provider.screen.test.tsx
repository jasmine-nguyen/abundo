// WHIT-275 — applyTransactionEdit's optimistic cache write + rollback. Drives the REAL
// action through AppProvider (../api + ../auth mocked): it patches the singleton
// ['transactions'] feed cache the detail screen reads, calls setTransactionFields with ONLY the
// changed fields, and rolls back on failure. A note/tag edit invalidates NOTHING (the feed is
// patched in place, never invalidated — an InfiniteData invalidate would storm every page).
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

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});
const cached = (id: string) =>
  readTransactionsCache(queryClient).find((t) => t.transaction_id === id);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); }); // clear the singleton's gcTime timers so none leak past the suite

function mount(transactions: Transaction[] = [txn()]) {
  seedTransactionsCache(queryClient, transactions);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saves a note optimistically, calls the API with only that field, and invalidates nothing', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', notes: 'lunch' });
  const result = mount();
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch' }); });

  expect(cached('t1')?.notes).toBe('lunch'); // optimistic cache write
  expect(mockApi.setTransactionFields).toHaveBeenCalledWith('t1', { notes: 'lunch' });
  const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).not.toContain('transactions'); // the feed is patched in place, never invalidated
  expect(keys).toHaveLength(0); // a plain note edit touches no server-derived cache either
  invalidateSpy.mockRestore();
});

it('rolls the note back to its previous value (and toasts) on save failure', async () => {
  mockApi.setTransactionFields.mockRejectedValue(new Error('boom'));
  const result = mount([txn({ notes: 'old note' })]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'new note' }); });

  expect(cached('t1')?.notes).toBe('old note'); // reverted
  expect(result.current.toast).toMatch(/could not save/i);
});

it('adds tags optimistically without clobbering the note', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', tags: ['work'] });
  const result = mount([txn({ notes: 'keep me' })]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { tags: ['work'] }); });

  expect(cached('t1')?.tags).toEqual(['work']);
  expect(cached('t1')?.notes).toBe('keep me'); // the other field is untouched
});

it('rolls tags back to absent on failure when there were none before', async () => {
  mockApi.setTransactionFields.mockRejectedValue(new Error('boom'));
  const result = mount([txn()]); // no tags

  await act(async () => { await result.current.applyTransactionEdit('t1', { tags: ['work'] }); });

  expect(cached('t1')?.tags).toBeUndefined(); // restored to absent, not []
});

it('is a no-op (no API call) when the transaction is not in the cache', async () => {
  const result = mount([]);
  await act(async () => { await result.current.applyTransactionEdit('ghost', { notes: 'x' }); });
  expect(mockApi.setTransactionFields).not.toHaveBeenCalled();
});

// WHIT-296: the budget-exclude override rides the same optimistic write + rollback.
it('excludes from budgets optimistically, calling the API with only that field', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', budget_excluded: true });
  const result = mount([txn({ notes: 'keep me' })]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(cached('t1')?.budget_excluded).toBe(true); // optimistic cache write
  expect(cached('t1')?.notes).toBe('keep me');      // other fields untouched
  expect(mockApi.setTransactionFields).toHaveBeenCalledWith('t1', { budget_excluded: true });
});

it('rolls budget_excluded back to absent on failure when it was unset before', async () => {
  // Without the widened rollback snapshot this stays stuck `true` — the fail-on-revert anchor.
  mockApi.setTransactionFields.mockRejectedValue(new Error('boom'));
  const result = mount([txn()]); // no override

  await act(async () => { await result.current.applyTransactionEdit('t1', { budget_excluded: true }); });

  expect(cached('t1')?.budget_excluded).toBeUndefined(); // restored to absent, not true
  expect(result.current.toast).toMatch(/could not save/i);
});
