// WHIT-275 — adversarial GAP tests for applyTransactionEdit through the REAL AppProvider.
// The implementer covers: note optimistic+invalidate, rollback+toast, tags without clobbering
// a PRE-EXISTING note, tags rollback to absent, no-op when uncached. These add: (1) two
// SEQUENTIAL edits — note then tags — where the second reads the cache the FIRST just patched,
// so neither field clobbers the other (each call re-reads getQueryData, not a stale snapshot);
// (2) clearing a note optimistically writes "" and PATCHes only { notes: "" }.
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
afterEach(() => { queryClient.clear(); });

function mount(transactions: Transaction[] = [txn()]) {
  queryClient.setQueryData(['transactions'], transactions);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('a note edit then a tags edit both land — the tags call does not drop the note', async () => { // [A20]
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1' });
  const result = mount([txn()]); // starts with neither note nor tags

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'lunch' }); });
  await act(async () => { await result.current.applyTransactionEdit('t1', { tags: ['work'] }); });

  // The second edit read the cache the first patched, so BOTH survive.
  expect(cached('t1')?.notes).toBe('lunch');
  expect(cached('t1')?.tags).toEqual(['work']);
  // Each PATCH carried only its own field (never re-sent the other).
  expect(mockApi.setTransactionFields).toHaveBeenNthCalledWith(1, 't1', { notes: 'lunch' });
  expect(mockApi.setTransactionFields).toHaveBeenNthCalledWith(2, 't1', { tags: ['work'] });
});

it('clearing a note writes "" optimistically and PATCHes only { notes: "" }', async () => { // [A21]
  mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 't1' });
  const result = mount([txn({ notes: 'old', tags: ['keep'] })]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: '' }); });

  expect(cached('t1')?.notes).toBe('');           // cleared in the cache
  expect(cached('t1')?.tags).toEqual(['keep']);   // tags untouched
  expect(mockApi.setTransactionFields).toHaveBeenCalledWith('t1', { notes: '' });
});
