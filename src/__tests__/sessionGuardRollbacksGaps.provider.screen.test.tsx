// WHIT-271 — GAP coverage for the session-epoch guard. The implementer's
// sessionGuardRollbacks.provider.screen.test.tsx pins persistPayCycle / saveLoanFacts /
// saveGoal / deleteGoal / saveBudget / applyCategory('one'). This file adds the writers
// they did NOT test individually — the seven toast-only writers (createCategoryInline,
// saveCategory, deleteCategory, deleteRule, saveManualRule, updateRule, applyTransactionEdit),
// the applyCategory('all') scope, and IN-SESSION control tests proving the guard did not
// break the happy path. Harness mirrors the implementer's: live mini auth store, mocked
// ../api, the real queryClient, sign-out = clear() then broadcast 'anon'.
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Sign out in PRODUCTION order: clearSession() wipes the cache, THEN broadcasts anon,
// which the context turns into the sessionEpoch bump.
function signOut() {
  act(() => { queryClient.clear(); mockSetStatus('anon'); });
}

const cat = (id: string, name: string) => ({ id, name, bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
  jest.useRealTimers();
});

describe('WHIT-271 gaps — toast-only writers settling AFTER sign-out show no toast + touch no cache', () => {
  it('[A-CCI] createCategoryInline SUCCESS after sign-out does not toast or re-seat categories', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Old')]);
    const d = deferred<{ id: string; name: string; bucket: string }>();
    mockApi.createCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.createCategoryInline({ name: 'New', bucket: 'Living' as never, icon: 'tag' }); });
    signOut();
    await act(async () => { d.resolve({ id: 'c2', name: 'New', bucket: 'Living' }); await pending; });

    expect(result.current.toast).toBeNull();                       // no 'Category created.' into the next session
    expect(queryClient.getQueryData(['categories'])).toBeUndefined(); // guarded write no-ops on cleared cache
  });

  it('[A-SC] saveCategory (edit) FAILURE after sign-out does not toast or re-seat categories', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Old')]);
    const d = deferred<unknown>();
    mockApi.updateCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveCategory('c1', { name: 'New', bucket: 'Living' as never, icon: 'tag' }); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(result.current.toast).toBeNull();
    expect(returned).toBe(false);
    expect(queryClient.getQueryData(['categories'])).toBeUndefined();
  });

  it('[A-DC] deleteCategory FAILURE after sign-out does not toast', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Old')]);
    const d = deferred<{ id: string }>();
    mockApi.deleteCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteCategory('c1'); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(result.current.toast).toBeNull();
    expect(returned).toBe(false);
  });

  it('[A-DR] deleteRule FAILURE after sign-out shows no toast and does not resurrect the rule', async () => {
    queryClient.setQueryData(['rules'], [{ id: 'r1', pattern: 'COLES', categoryId: 'c1', isNew: false }]);
    const d = deferred<{ id: string }>();
    mockApi.deleteEnrichment.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.deleteRule('r1'); });
    signOut();
    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(result.current.toast).toBeNull();
    // reinsertBefore(prev, removed, …) would re-plant r1 — the guarded patchRules no-ops instead.
    expect(queryClient.getQueryData(['rules'])).toBeUndefined();
  });

  it('[A-SMR] saveManualRule FAILURE after sign-out shows no toast and seeds no rules list', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['rules'], []);
    const d = deferred<unknown>();
    mockApi.createEnrichment.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.saveManualRule('COLES', 'c1'); });
    signOut();
    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(result.current.toast).toBeNull(); // the pre-await 'Rule added…' was cleared by sign-out; the catch toast is gated
    expect(queryClient.getQueryData(['rules'])).toBeUndefined();
  });

  it('[A-UR] updateRule FAILURE after sign-out shows no toast', async () => {
    queryClient.setQueryData(['rules'], [{ id: 'r1', pattern: 'OLD', categoryId: 'c1', isNew: false, field: 'description', operator: 'contains' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    const d = deferred<unknown>();
    mockApi.updateEnrichment.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.updateRule('r1', 'NEW', 'c1'); });
    signOut();
    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(result.current.toast).toBeNull();
  });

  it('[A-ATE] applyTransactionEdit FAILURE after sign-out shows no toast and re-seats no transactions', async () => {
    queryClient.setQueryData(['transactions'], [{ transaction_id: 't1', notes: 'old', tags: ['a'], category: null, counts_to_budget: true, description: 'X' }]);
    const d = deferred<unknown>();
    mockApi.setTransactionFields.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.applyTransactionEdit('t1', { notes: 'new' }); });
    signOut();
    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(result.current.toast).toBeNull();
    expect(queryClient.getQueryData(['transactions'])).toBeUndefined();
  });

  it('[A-ACALL] applyCategory("all") FAILURE after sign-out shows no toast (the :701 leak)', async () => {
    queryClient.setQueryData(['transactions'], [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' }]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    mockApi.createEnrichment.mockResolvedValue({ id: 'r1', value: 'COLES', categoryId: 'c1' } as never);
    const dBatch = deferred<unknown>();
    mockApi.setTransactionCategories.mockImplementation(() => dBatch.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'c1' } as never); });
    let pending!: Promise<void>;
    act(() => { pending = result.current.applyCategory('all'); });
    signOut();
    // The batch rejects → every swept id is "failed" → the :701 'Could not save some…' toast branch.
    await act(async () => { dBatch.reject(new Error('network')); await pending; });

    expect(result.current.toast).toBeNull();
  });
});

// In-session CONTROL / regression: with NO sign-out the epoch never changes, so every guard
// (`epoch === sessionEpoch.current`) must be TRUE — the toast STILL fires and the cache STILL
// writes. Proves WHIT-271 did not silently kill the happy path. Fake timers tame showToast's
// 3400ms auto-dismiss so the asserted toast is still present.
describe('WHIT-271 gaps — in-session control: the guard does not break the happy path', () => {
  it('[A-CTRL-CCI] createCategoryInline success (no sign-out) toasts AND appends to the cache', async () => {
    jest.useFakeTimers();
    queryClient.setQueryData(['categories'], [cat('c1', 'Old')]);
    mockApi.createCategory.mockResolvedValue({ id: 'c2', name: 'New', bucket: 'Living' } as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.createCategoryInline({ name: 'New', bucket: 'Living' as never, icon: 'tag' }); });

    expect(result.current.toast).toBe('Category created.');
    const cats = queryClient.getQueryData<{ id: string }[]>(['categories']) ?? [];
    expect(cats.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('[A-CTRL-DR] deleteRule failure (no sign-out) toasts AND reinserts the rule', async () => {
    jest.useFakeTimers();
    queryClient.setQueryData(['rules'], [{ id: 'r1', pattern: 'COLES', categoryId: 'c1', isNew: false }]);
    mockApi.deleteEnrichment.mockRejectedValue(new Error('network') as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.deleteRule('r1'); await flush(); });

    expect(result.current.toast).toBe('Could not delete rule. Please try again.');
    expect(queryClient.getQueryData<{ id: string }[]>(['rules'])?.map((r) => r.id)).toEqual(['r1']);
  });

  it('[A-CTRL-ATE] applyTransactionEdit failure (no sign-out) toasts AND rolls the field back', async () => {
    jest.useFakeTimers();
    queryClient.setQueryData(['transactions'], [{ transaction_id: 't1', notes: 'old', tags: ['a'], category: null, counts_to_budget: true, description: 'X' }]);
    mockApi.setTransactionFields.mockRejectedValue(new Error('network') as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'new' }); await flush(); });

    expect(result.current.toast).toBe('Could not save. Please try again.');
    const tx = queryClient.getQueryData<{ notes: string }[]>(['transactions'])?.[0];
    expect(tx?.notes).toBe('old'); // rolled back to the snapshot
  });
});
