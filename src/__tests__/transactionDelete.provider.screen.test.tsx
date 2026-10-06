// WHIT-654 — deleteTransaction: the user removes one charge (e.g. a duplicate) from the detail
// screen. Drives the REAL action through AppProvider over the fake server. Proves the charge leaves
// every cached copy at once, the totals are marked for a refresh, and a failed delete puts every
// copy back and warns.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';

jest.mock('../auth', () => ({
  getStatus: () => 'authed',
  subscribe: () => () => {},
  getAuthToken: async () => 'test-id-token',
}));
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';

const server = installFakeServer();

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 'dup', date: '2026-09-27', authorized_date: '2026-09-27',
  description: 'ANTHROPIC* CLAUDE SUB', merchant_name: 'Anthropic', amount: -170.01, account_id: 'a1',
  account_name: 'Westpac', category: 'subscriptions', status: 'pending', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});
const KEEP = txn({ transaction_id: 'keep', status: 'posted' });

function seedEveryCopy() {
  seedTransactionsCache(queryClient, [txn(), KEEP]);
  queryClient.setQueryData(['transactionsSearch', 'claude'], { transactions: [txn(), KEEP], truncated: false });
  queryClient.setQueryData(['budgetTransactions', 'subscriptions'], [txn(), KEEP]);
  queryClient.setQueryData(['categoryTransactions', 'subscriptions'], [txn()]);
}

function ids(rows: Transaction[] | undefined) {
  return (rows ?? []).map((row) => row.transaction_id);
}

function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('removes the charge from the feed, search and the budget and category lists, and refreshes the totals', async () => {
  seedEveryCopy();
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteTransaction('dup'); });

  expect(ok).toBe(true);
  expect(server.requests()).toContainEqual({ method: 'DELETE', path: '/transactions/dup', body: undefined });
  expect(ids(readTransactionsCache(queryClient))).toEqual(['keep']);
  expect(ids(queryClient.getQueryData<{ transactions: Transaction[] }>(['transactionsSearch', 'claude'])?.transactions)).toEqual(['keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['budgetTransactions', 'subscriptions']))).toEqual(['keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['categoryTransactions', 'subscriptions']))).toEqual([]);
  const refreshed = invalidatedKeys(invalidate);
  expect(refreshed).toEqual(expect.arrayContaining(['budgets', 'breakdown', 'uncategorizedCount']));
  invalidate.mockRestore();
});

it('a failed delete puts the charge back everywhere and warns', async () => {
  seedEveryCopy();
  server.fail('/transactions/dup', 500);
  const result = mount();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteTransaction('dup'); });

  expect(ok).toBe(false);
  expect(ids(readTransactionsCache(queryClient))).toEqual(['dup', 'keep']);
  expect(ids(queryClient.getQueryData<{ transactions: Transaction[] }>(['transactionsSearch', 'claude'])?.transactions)).toEqual(['dup', 'keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['budgetTransactions', 'subscriptions']))).toEqual(['dup', 'keep']);
  expect(ids(queryClient.getQueryData<Transaction[]>(['categoryTransactions', 'subscriptions']))).toEqual(['dup']);
  expect(result.current.toast).toBe('Could not delete. Please try again.');
});
