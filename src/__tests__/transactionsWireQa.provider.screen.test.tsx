// WHIT-650 QA — the transaction writes over the REAL request code (src/api.ts) against the fake
// server: lost connections, whole-batch errors, partial batches and the server-minted rule id.
// These paths could not be reached with the bare jest.mock('../api') auto-mock the moved suites used.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { DINING, GROCERIES } from './support/categories';
import { invalidatedKeys } from './support/queryClient';
import { colesTxn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const CAT = GROCERIES;
const txn = (id: string, extra: Partial<Transaction> = {}) => colesTxn({ transaction_id: id, ...extra });
const cached = (id: string) => readTransactionsCache(queryClient).find((t) => t.transaction_id === id);
beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); jest.restoreAllMocks(); });

function mount(transactions: Transaction[]) {
  seedTransactionsCache(queryClient, transactions);
  queryClient.setQueryData(['categories'], [{ ...CAT }, { ...DINING }]);
  queryClient.setQueryData(['budgets', 14], {});
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// [A1]
it('a note edit whose connection drops puts the old note back and toasts', async () => {
  server.once('PATCH', '/transactions/t1', 'dropped');
  const result = mount([txn('t1', { notes: 'old note' })]);

  await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'new note' }); });

  expect(server.sent('PATCH', '/transactions/t1')).toHaveLength(1);
  expect(cached('t1')?.notes).toBe('old note');
  expect(result.current.toast).toBe('Could not save. Please try again.');
});

// [A2]
it("applyCategory('one') on a dropped connection puts the charge back to its old category and skips the count refresh", async () => {
  server.once('PATCH', '/transactions/t1', 'dropped');
  const result = mount([txn('t1', { category: 'dining' })]);
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategory('one'); });

  expect(cached('t1')?.category).toBe('dining');
  expect(result.current.toast).toBe('Could not save category. Please try again.');
  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
});

// [A3]
it('applyCategoryToMany with a partial batch reverts only the unsaved charge and still refreshes the count', async () => {
  server.once('PATCH', '/transactions', { body: { results: [{ id: 't1', status: 'updated' }, { id: 't2', status: 'not_found' }] } });
  const result = mount([txn('t1'), txn('t2', { category: 'dining' })]);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(cached('t1')?.category).toBe('groceries');
  expect(cached('t2')?.category).toBe('dining');
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
});

// [A4]
it('applyCategoryToMany when the batch request itself errors reverts every charge and refreshes nothing', async () => {
  server.once('PATCH', '/transactions', { status: 500 });
  const result = mount([txn('t1'), txn('t2', { category: 'dining' })]);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(server.sent('PATCH', '/transactions')).toHaveLength(1);
  expect(cached('t1')?.category).toBeNull();
  expect(cached('t2')?.category).toBe('dining');
  expect(result.current.toast).toBe('Could not save some categories. Please try again.');
  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
});

// [A5]
it('applyCategoryToMany on a dropped connection reverts every charge', async () => {
  server.once('PATCH', '/transactions', 'dropped');
  const result = mount([txn('t1'), txn('t2', { category: 'dining' })]);

  await act(async () => { await result.current.applyCategoryToMany(['t1', 't2'], 'groceries'); });

  expect(cached('t1')?.category).toBeNull();
  expect(cached('t2')?.category).toBe('dining');
});

// [A6]
it("applyCategory('all') swaps the temp rule for the id the server minted, keeping the NEW badge", async () => {
  const result = mount([txn('t1'), txn('t2')]);
  queryClient.setQueryData(['rules'], []);
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('all'); });

  expect(server.sent('POST', '/rules')).toEqual([{ method: 'POST', path: '/rules', body: { value: 'COLES', categoryId: 'groceries' } }]);
  expect(queryClient.getQueryData(['rules'])).toEqual([
    expect.objectContaining({ id: 'rule-1', pattern: 'COLES', categoryId: 'groceries', isNew: true }),
  ]);
});

// [A7]
it("applyCategory('all') whose rule mint is refused (409) files the charges, drops the temp rule and says so", async () => {
  server.once('POST', '/rules', { status: 409 });
  const result = mount([txn('t1'), txn('t2')]);
  queryClient.setQueryData(['rules'], []);
  act(() => result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'groceries' }));

  await act(async () => { await result.current.applyCategory('all'); });

  expect(cached('t1')?.category).toBe('groceries');
  expect(cached('t2')?.category).toBe('groceries');
  expect(queryClient.getQueryData(['rules'])).toEqual([]);
  expect(result.current.toast).toBe('Filed, but could not save the rule for future charges.');
});

// [A8]
it('an edit on an id with a slash is sent as one encoded path segment and lands', async () => {
  const result = mount([txn('bank/1')]);

  await act(async () => { await result.current.applyTransactionEdit('bank/1', { notes: 'lunch' }); });

  expect(server.requests()).toContainEqual({ method: 'PATCH', path: '/transactions/bank%2F1', body: { notes: 'lunch' } });
  expect(cached('bank/1')?.notes).toBe('lunch');
  expect(result.current.toast).toBeNull();
});
