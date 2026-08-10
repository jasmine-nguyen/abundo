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
import type { Bucket } from '../context';
import { queryClient } from '../queryClient';
import { ApiError } from '../apiError';
import { seedTransactionsCache, readTransactionsCache } from './support/transactionsCache';
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

// ----- module-level helpers hoisted from the folded gaps files -----
// From sessionGuardRollbacksGaps: a category factory and a two-microtask flush.
const cat = (id: string, name: string) => ({ id, name, bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
// From categorySilentContractGaps: the 50-sub-category cap message, a reusable form, and the silent opt.
const CAP = 'a category can have at most 50 sub-categories';
const FORM = { name: 'Gym', bucket: 'Lifestyle' as Bucket, icon: 'dumbbell' };
const SILENT = { silent: true };

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
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'X' }]);
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

// ===== WHIT-271 (folded from sessionGuardRollbacksGaps.provider.screen.test.tsx) =====
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
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', notes: 'old', tags: ['a'], category: null, counts_to_budget: true, description: 'X' }]);
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
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', category: null, counts_to_budget: true, description: 'COLES' }]);
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
    seedTransactionsCache(queryClient, [{ transaction_id: 't1', notes: 'old', tags: ['a'], category: null, counts_to_budget: true, description: 'X' }]);
    mockApi.setTransactionFields.mockRejectedValue(new Error('network') as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.applyTransactionEdit('t1', { notes: 'new' }); await flush(); });

    expect(result.current.toast).toBe('Could not save. Please try again.');
    const tx = readTransactionsCache(queryClient)[0];
    expect(tx?.notes).toBe('old'); // rolled back to the snapshot
  });
});

// ===== WHIT-437 (folded from categorySilentContractGaps.provider.screen.test.tsx) =====
describe('[A20] saveCategory delegates a CREATE — the reason must survive the hop', () => {
  // saveCategory(null, form, opts) is `return (await createCategoryInline(form, opts)) !== null`.
  // The `!== null` reads like a swallow; it is not — the await re-throws. Pinned because the
  // obvious "fix" (wrapping the delegation in its own try) would silently drop the reason.
  it('rejects with the SAME ApiError, reason intact, and fires no toast', async () => {
    const refusal = new ApiError(400, CAP);
    mockApi.createCategory.mockRejectedValue(refusal as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let caught: unknown = 'never rejected';
    await act(async () => {
      caught = await result.current.saveCategory(null, FORM, SILENT).then(() => 'resolved', (e: unknown) => e);
    });
    expect(caught).toBe(refusal);                       // the identical object, not a re-wrap
    expect((caught as ApiError).serverMessage).toBe(CAP);
    expect(result.current.toast).toBeNull();            // WHIT-240: silent still means silent
  });

  it('rejects on the NON-silent create path only by returning false + toasting the reason', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiError(409, 'category already exists') as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.saveCategory(null, FORM).then((v) => v, (e: unknown) => e);
    });
    expect(returned).toBe(false);                       // no throw escapes the default path
    expect(result.current.toast).toBe('Category already exists.');
  });
});

describe('[A21][A22] a blank name is a validation bail, never a rejection', () => {
  // Guarded BEFORE the try, so it can't reach the new `throw`. edit.tsx's canSave blocks this
  // today, but Overlays/QuickCreateCategory trim independently — a regression here would surface
  // as a red console.error from useInFlightGuard on a whitespace name.
  it('createCategoryInline({ name: "   " }, { silent: true }) resolves null and never calls the API', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.createCategoryInline({ ...FORM, name: '   ' }, SILENT)
        .then((v) => v, (e: unknown) => ({ threw: e }));
    });
    expect(returned).toBeNull();
    expect(mockApi.createCategory).not.toHaveBeenCalled();
    expect(result.current.toast).toBeNull();
  });

  it('saveCategory(null, { name: "" }, { silent: true }) resolves false and never calls the API', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.saveCategory(null, { ...FORM, name: '' }, SILENT)
        .then((v) => v, (e: unknown) => ({ threw: e }));
    });
    expect(returned).toBe(false);
    expect(mockApi.createCategory).not.toHaveBeenCalled();
  });

  it('saveCategory("gym", { name: "   " }, { silent: true }) resolves false and never calls the API', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.saveCategory('gym', { ...FORM, name: '   ' }, SILENT)
        .then((v) => v, (e: unknown) => ({ threw: e }));
    });
    expect(returned).toBe(false);
    expect(mockApi.updateCategory).not.toHaveBeenCalled();
  });
});

describe('[A23] a SIGN-OUT mid-flight keeps the falsy return — it must not become a rejection', () => {
  // The epoch check sits ABOVE the `if (opts?.silent) throw error`. If the order were swapped,
  // signing out during a bulk save would reject → edit.tsx's catch runs → the WHIT-282 guard
  // there catches it, but a NULL-reason network error would ALSO be re-thrown into
  // console.error. Order matters; pin it.
  it('createCategoryInline silent + failed + signed out → resolves null, no toast, no throw', async () => {
    const d = deferred<never>();
    mockApi.createCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.createCategoryInline(FORM, SILENT).then((v) => v, (e: unknown) => ({ threw: e })); });
    signOut();
    let returned: unknown = 'unset';
    await act(async () => { d.reject(new ApiError(400, CAP)); returned = await pending; });

    expect(returned).toBeNull();
    expect(result.current.toast).toBeNull();
  });

  it('saveCategory (update) silent + failed + signed out → resolves false, no toast, no throw', async () => {
    const d = deferred<never>();
    mockApi.updateCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.saveCategory('gym', FORM, SILENT).then((v) => v, (e: unknown) => ({ threw: e })); });
    signOut();
    let returned: unknown = 'unset';
    await act(async () => { d.reject(new ApiError(400, CAP)); returned = await pending; });

    expect(returned).toBe(false);
    expect(result.current.toast).toBeNull();
  });
});

describe('[A26] a silent SUCCESS is unchanged', () => {
  it('createCategoryInline silent returns the created row with no toast', async () => {
    mockApi.createCategory.mockResolvedValue({ id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#fff' } as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let created: unknown = 'unset';
    await act(async () => { created = await result.current.createCategoryInline(FORM, SILENT); });
    expect(created).toMatchObject({ id: 'gym', name: 'Gym' });
    expect(result.current.toast).toBeNull();
  });
});
