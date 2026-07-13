// WHIT-275 — applyTransactionEdit's optimistic cache write + rollback. Drives the REAL
// action through AppProvider (../api + ../auth mocked): it patches the singleton
// ['transactions'] cache the detail screen reads, calls setTransactionFields with ONLY the
// changed fields, invalidates ['transactions'] on success, and rolls back on failure.
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

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});
const cached = (id: string) =>
  (queryClient.getQueryData<Transaction[]>(['transactions']) ?? []).find((t) => t.transaction_id === id);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); }); // clear the singleton's gcTime timers so none leak past the suite

function mount(transactions: Transaction[] = [txn()]) {
  queryClient.setQueryData(['transactions'], transactions);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saves a note optimistically, calls the API with only that field, and invalidates transactions', async () => {
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1', notes: 'lunch' });
  const result = mount();
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch' }); });

  expect(cached('t1')?.notes).toBe('lunch'); // optimistic cache write
  expect(mockApi.setTransactionFields).toHaveBeenCalledWith('t1', { notes: 'lunch' });
  const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toContain('transactions');
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
