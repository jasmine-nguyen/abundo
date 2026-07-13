// WHIT-271 — a save/toast that settles AFTER sign-out must be a no-op: it must not re-seat the
// old account's data into the freshly-cleared query cache, nor toast into the next session. The
// four rollback writers (persistPayCycle, saveLoanFacts, saveGoal, deleteGoal) and the late
// toasts were unguarded; this pins the session-epoch guard reused from WHIT-268. Harness mirrors
// overlaysAuthClearGaps [A10]: live miniature auth store, mocked ../api, the real queryClient.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => {
  mockStatus = s;
  mockListeners.forEach((l) => l());
};
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (l: () => void) => mockSubscribe(l),
}));
jest.mock('../api');
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => ({})),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
}));

import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

// A deferred promise whose resolve/reject the test controls, so the writer is genuinely
// in-flight when the session ends (mirrors [A10]'s createEnrichment control).
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Sign out in PRODUCTION order: clearSession() wipes the cache, THEN broadcasts anon (which the
// context's subscription turns into the epoch bump). Matches [A10]:175.
function signOut() {
  act(() => { queryClient.clear(); mockSetStatus('anon'); });
}

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
  jest.useRealTimers();
});

describe('WHIT-271 — a writer settling after sign-out re-seats nothing and shows no toast', () => {
  // persistPayCycle is internal; setPayCycleLength/setPayday are the public entry points. Since
  // they return void (not the promise), flush a couple of microtasks to let the catch settle.
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

  it('persistPayCycle failure after sign-out does not re-seat the old cycle or toast', async () => {
    queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2026-06-06' });
    const d = deferred<api.PayCycle>();
    mockApi.setPayCycle.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => { result.current.setPayCycleLength(30); });
    signOut();
    await act(async () => { d.reject(new Error('network')); await flush(); });

    expect(queryClient.getQueryData(['payCycle'])).toBeUndefined(); // old cycle NOT re-seated
    expect(result.current.toast).toBeNull();
  });

  it('epoch beats the freshness window: a stale payCycle failure cannot overwrite the NEXT account', async () => {
    queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2026-06-06' });
    const d = deferred<api.PayCycle>();
    mockApi.setPayCycle.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => { result.current.setPayCycleLength(30); });
    signOut();
    // A NEW account signs in and loads its own cycle BEFORE the stale failure lands.
    act(() => mockSetStatus('authed'));
    queryClient.setQueryData(['payCycle'], { length: 7, last_pay_date: '2026-07-10' });
    await act(async () => { d.reject(new Error('network')); await flush(); });

    // The new account's cycle must survive — a guarded-updater (prev ? prev-value : prev) would
    // have overwritten it with the old length; only the epoch drops the write entirely.
    expect(queryClient.getQueryData(['payCycle'])).toEqual({ length: 7, last_pay_date: '2026-07-10' });
  });

  it('saveLoanFacts failure after sign-out does not re-seat the old facts, toast, or return true', async () => {
    queryClient.setQueryData(['loanFacts'], { balance: 111, rate: 5 });
    const d = deferred<api.LoanFactsInput>();
    mockApi.setLoanFacts.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveLoanFacts({ balance: 222, rate: 6 } as never); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(queryClient.getQueryData(['loanFacts'])).toBeUndefined(); // old facts NOT re-seated
    expect(result.current.toast).toBeNull();
    expect(returned).toBe(false); // no stray router.back() after the login redirect
  });

  it('saveGoal SUCCESS after sign-out does not seed a stale goals list or toast', async () => {
    queryClient.setQueryData(['goals'], [{ id: 'g1', target: 100 }]);
    const d = deferred<api.GoalRecord>();
    mockApi.saveGoal.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveGoal('g1', { target: 200 } as never); });
    signOut();
    // Even a SUCCESS re-seat launders `(prev ?? []).map(...)` = [] into the cleared cache.
    await act(async () => { d.resolve({ id: 'g1', target: 200 } as never); await pending; });

    expect(queryClient.getQueryData(['goals'])).toBeUndefined();
    expect(result.current.toast).toBeNull();
  });

  it('deleteGoal failure after sign-out does not resurrect the removed goal or toast', async () => {
    queryClient.setQueryData(['goals'], [{ id: 'g1', target: 100 }]);
    const d = deferred<{ id: string }>();
    mockApi.deleteGoal.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteGoal('g1'); });
    signOut();
    await act(async () => { d.reject(new Error('network')); await pending; });

    // reinsertBefore(prev ?? [], removed, …) would re-plant the old goal into the wiped cache.
    expect(queryClient.getQueryData(['goals'])).toBeUndefined();
    expect(result.current.toast).toBeNull();
  });

  it('saveBudget SUCCESS after sign-out shows no toast (the leak: old category name + dollar figure)', async () => {
    queryClient.setQueryData(['categories'], [{ id: 'c1', name: 'Groceries', bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 }]);
    const d = deferred<{ target: number }>();
    mockApi.setBudget.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveBudget('c1', 500); });
    signOut();
    await act(async () => { d.resolve({ target: 500 }); await pending; });

    // The success toast renders `${c.name} … ${fmt(saved.target)}` — the OLD account's data.
    expect(result.current.toast).toBeNull();
  });

  it('applyCategory failure after sign-out shows no toast', async () => {
    queryClient.setQueryData(['transactions'], [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'X' }]);
    queryClient.setQueryData(['categories'], [{ id: 'c1', name: 'Groceries', bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 }]);
    const d = deferred<unknown>();
    mockApi.setTransactionCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'c1' } as never); });
    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategory('one'); });
    signOut();
    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(result.current.toast).toBeNull();
  });

  // F1 (from QA + code-critic): the value-returning writers must return their FAILURE sentinel
  // after sign-out, so the edit SCREENS (which toast + router.back() on a truthy return) don't
  // fire into the next session. These lock the return value, not just the writer's own toast.
  it('saveBudget SUCCESS after sign-out returns false (so budget/edit does not navigate)', async () => {
    queryClient.setQueryData(['categories'], [{ id: 'c1', name: 'Groceries', bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 }]);
    const d = deferred<{ target: number }>();
    mockApi.setBudget.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveBudget('c1', 500); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.resolve({ target: 500 }); returned = await pending; });
    expect(returned).toBe(false);
  });

  it('saveCategory SUCCESS after sign-out returns false (so category/edit does not toast + navigate)', async () => {
    queryClient.setQueryData(['categories'], [{ id: 'c1', name: 'Old', bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 }]);
    const d = deferred<unknown>();
    mockApi.updateCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveCategory('c1', { name: 'New', bucket: 'Living' as never, icon: 'tag' }); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.resolve({ id: 'c1', name: 'New', bucket: 'Living', icon: 'tag' }); returned = await pending; });
    expect(returned).toBe(false);
  });

  it('createCategoryInline SUCCESS after sign-out returns null (so callers do not act on it)', async () => {
    queryClient.setQueryData(['categories'], [{ id: 'c1', name: 'Old', bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 }]);
    const d = deferred<{ id: string; name: string; bucket: string }>();
    mockApi.createCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.createCategoryInline({ name: 'New', bucket: 'Living' as never, icon: 'tag' }); });
    signOut();
    let returned!: unknown;
    await act(async () => { d.resolve({ id: 'c2', name: 'New', bucket: 'Living' }); returned = await pending; });
    expect(returned).toBeNull();
  });

  it('deleteRule failure cannot append the old rule into the NEXT account (freshness window)', async () => {
    // The bug code-critic found: patchRules' `prev ? … : prev` only no-ops on the CLEARED cache.
    // Once account B has re-loaded ['rules'], a stale reinsertBefore (successorIds absent) APPENDS
    // account A's rule into B's list. Only the epoch guard drops the write.
    queryClient.setQueryData(['rules'], [{ id: 'rA', pattern: 'COLES', categoryId: 'cA', isNew: false }]);
    const d = deferred<{ id: string }>();
    mockApi.deleteEnrichment.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.deleteRule('rA'); });
    signOut();
    act(() => mockSetStatus('authed'));
    queryClient.setQueryData(['rules'], [{ id: 'rB', pattern: 'WOOLIES', categoryId: 'cB', isNew: false }]);
    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(queryClient.getQueryData<{ id: string }[]>(['rules'])?.map((r) => r.id)).toEqual(['rB']);
  });

  it('deleteGoal SUCCESS after sign-out returns false (so goal/edit does not navigate)', async () => {
    queryClient.setQueryData(['goals'], [{ id: 'g1', target: 100 }]);
    const d = deferred<{ id: string }>();
    mockApi.deleteGoal.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteGoal('g1'); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.resolve({ id: 'g1' }); returned = await pending; });
    expect(returned).toBe(false);
  });
});
