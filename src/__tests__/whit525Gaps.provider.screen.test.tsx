// WHIT-525 — adversarial gap tests for the optimistic stamp/rollback paths.
// Does NOT duplicate budgetTxOptimistic (exclude→mark, rollback) or budgetTxEditGaps
// ([E1]-[E5]). These cover:
//   [A11] Re-including a previously-excluded row flips budget_excluded back to false.
//   [A12] Exclude stamps across MULTIPLE distinct category-drill cache keys (same row, two cycles).
//   [A13] Exclude + rollback on a row in both feed AND a budget list restores both.
//   [A14] An edit on a fully-evicted row (no feed, no scoped cache) is a no-op — API not called.
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

describe('[WHIT-525 gaps] applyTransactionEdit stamp boundaries', () => {
  it('[A11] re-including a previously-excluded row un-stamps it in the budget list', async () => {
    mockApi.setTransactionFields.mockResolvedValueOnce({ transaction_id: 'bill', budget_excluded: true });
    const result = mount([txn('bill')]);
    queryClient.setQueryData(['budgetTransactions', 'insurance'], [txn('bill')]);

    await act(async () => { await result.current.applyTransactionEdit('bill', { budget_excluded: true }); });
    expect(budgetList('insurance')).toEqual([txn('bill', { budget_excluded: true })]);

    mockApi.setTransactionFields.mockResolvedValueOnce({ transaction_id: 'bill', budget_excluded: false });
    await act(async () => { await result.current.applyTransactionEdit('bill', { budget_excluded: false }); });
    expect(budgetList('insurance')).toEqual([txn('bill', { budget_excluded: false })]);
  });

  it('[A12] exclude stamps the row in every category-drill cache key under the prefix', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'bill', budget_excluded: true });
    const result = mount([txn('bill')]);
    const drillKey0 = ['categoryTransactions', 'coffee', 0];
    const drillKey1 = ['categoryTransactions', 'coffee', 1];
    queryClient.setQueryData(drillKey0, [txn('bill')]);
    queryClient.setQueryData(drillKey1, [txn('bill'), txn('other')]);

    await act(async () => { await result.current.applyTransactionEdit('bill', { budget_excluded: true }); });

    expect(queryClient.getQueryData(drillKey0)).toEqual([txn('bill', { budget_excluded: true })]);
    expect(queryClient.getQueryData(drillKey1)).toEqual([txn('bill', { budget_excluded: true }), txn('other')]);
  });

  it('[A13] rollback restores both the feed row and the budget list row on a failed exclude', async () => {
    let rejectSave: (e: unknown) => void = () => {};
    mockApi.setTransactionFields.mockReturnValue(new Promise((_res, rej) => { rejectSave = rej; }));
    const result = mount([txn('bill')]);
    queryClient.setQueryData(['budgetTransactions', 'food'], [txn('bill')]);

    let pending: Promise<void> = Promise.resolve();
    act(() => { pending = result.current.applyTransactionEdit('bill', { budget_excluded: true }); });

    expect(budgetList('food')).toEqual([txn('bill', { budget_excluded: true })]);

    await act(async () => { rejectSave(new Error('network')); await pending; });

    expect(budgetList('food')).toEqual([txn('bill')]);
  });

  it('[A14] edit on a fully-evicted row (no feed, no scoped cache) is a no-op — API not called', async () => {
    mockApi.setTransactionFields.mockResolvedValue({ transaction_id: 'gone', notes: 'test' });
    const result = mount([]);

    await act(async () => { await result.current.applyTransactionEdit('gone', { notes: 'test' }); });

    expect(mockApi.setTransactionFields).not.toHaveBeenCalled();
  });
});
