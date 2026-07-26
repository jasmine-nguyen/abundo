// WHIT-344 / WHIT-271 — the optimistic budget-list rollback added in applyTransactionEdit is the
// ONLY rollback writer in context.tsx that is neither epoch-guarded nor cache-existence-guarded:
//   budgetTxSnapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));   // line ~980
// The sibling patchTransactions rollback no-ops on the cleared cache (prev ? fn : prev) and the
// toast is epoch-gated — this raw setQueryData re-seats the PRIOR account's budget lists into the
// freshly-cleared cache when an exclude save fails after sign-out. This suite pins the WHIT-271
// invariant ("a writer settling after sign-out re-seats nothing"). Harness copied from
// sessionGuardRollbacks.provider.screen.test.tsx.
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
import type { Transaction } from '../context';
import { queryClient } from '../queryClient';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: 'groceries', status: 'posted', type: 'PAYMENT', counts_to_budget: true,
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

describe('WHIT-344 exclude rollback settling after sign-out', () => {
  it('does NOT re-seat the old account budget list into the cleared cache', async () => {
    queryClient.setQueryData(['transactions'], [txn()]);
    queryClient.setQueryData(['budgetTransactions', 'groceries'], [txn()]);
    const d = deferred<{ transaction_id: string; budget_excluded: boolean }>();
    mockApi.setTransactionFields.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyTransactionEdit('t1', { budget_excluded: true }); });
    signOut(); // cache cleared, epoch bumped, while the save is still in-flight
    await act(async () => { d.reject(new Error('network')); await pending; });

    // WHIT-271 invariant: nothing from the prior session may reappear in the wiped cache.
    expect(queryClient.getQueryData(['budgetTransactions', 'groceries'])).toBeUndefined();
  });
});
