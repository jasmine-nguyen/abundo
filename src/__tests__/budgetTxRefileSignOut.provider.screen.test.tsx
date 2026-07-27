// WHIT-348 — the NEW budget-list rollback added for the re-file paths uses a raw, epoch-gated
// setQueryData (context.tsx: budgetTxSnaps.forEach(([key, data]) => setQueryData(key, data))).
// Mirroring budgetTxOptimisticSignOut.provider.screen.test.tsx (WHIT-271/WHIT-344), a re-file save
// that FAILS *after sign-out* must not re-seat the prior account's budget list into the freshly
// cleared cache. The optimistic write went through removeRefiledFromBudgetLists (a raw setQueryData
// too), so only the sessionEpoch gate stops the restore from resurrecting it. This pins that gate.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: (l: () => void) => mockSubscribe(l) }));
jest.mock('../api');

import { AppProvider, useAppContext } from '../context';
import type { Transaction, Category } from '../context';
import { queryClient } from '../queryClient';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

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

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function signOut() { act(() => { queryClient.clear(); mockSetStatus('anon'); }); }

beforeEach(() => { mockStatus = 'authed'; mockListeners.clear(); queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

describe('WHIT-348 re-file budget-list rollback settling after sign-out', () => {
  it('does NOT re-seat the old account budget list into the cleared cache', async () => {
    queryClient.setQueryData(['transactions'], [txn()]);
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
