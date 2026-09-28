// WHIT-628 QA — the writers moved onto runSave that had no sign-out test of their own
// (saveSpread, removeSpread, deleteBudget), plus the undo/settle wiring of the optimistic
// writers when the save fails or succeeds while still signed in. Harness mirrors
// sessionGuardRollbacks.provider.screen.test.tsx: live miniature auth store, mocked ../api,
// the real queryClient.
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

// Production order: clearSession() wipes the cache, THEN broadcasts anon (the epoch bump).
function signOut() {
  act(() => { queryClient.clear(); mockSetStatus('anon'); });
}

const cat = (id: string, name: string) => ({ id, name, bucket: 'Living', icon: 'tag', color: '#fff', recent: 0 });
const rollup = (target: number) => ({ target, spent: 0 });

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  queryClient.clear();
  jest.clearAllMocks();
});
afterEach(() => {
  queryClient.clear();
  jest.restoreAllMocks();
});

describe('WHIT-628 — spread/budget writers settling after sign-out', () => {
  // [B1]
  it('saveSpread SUCCESS after sign-out returns false and shows no toast', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Rego')]);
    const d = deferred<unknown>();
    mockApi.setSpread.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveSpread('c1', 600, 6); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.resolve({}); returned = await pending; });

    expect(returned).toBe(false);
    expect(result.current.toast).toBeNull();
  });

  // [B2]
  it('removeSpread FAILURE after sign-out returns false and shows no toast', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Rego')]);
    const d = deferred<unknown>();
    mockApi.deleteSpread.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.removeSpread('c1'); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(returned).toBe(false);
    expect(result.current.toast).toBeNull();
  });

  // [B3]
  it('deleteBudget FAILURE after sign-out cannot overwrite the NEXT account\'s budgets', async () => {
    queryClient.setQueryData(['budgets'], { c1: rollup(100) });
    const d = deferred<{ id: string }>();
    mockApi.deleteBudget.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteBudget('c1'); });
    signOut();
    act(() => mockSetStatus('authed'));
    queryClient.setQueryData(['budgets'], { other: rollup(7) });
    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(queryClient.getQueryData(['budgets'])).toEqual({ other: rollup(7) });
    expect(returned).toBe(false);
    expect(result.current.toast).toBeNull();
  });

  // [B4]
  it('deleteBudget SUCCESS after sign-out returns false and shows no toast', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['budgets'], { c1: rollup(100) });
    const d = deferred<{ id: string }>();
    mockApi.deleteBudget.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteBudget('c1'); });
    signOut();
    let returned!: boolean;
    await act(async () => { d.resolve({ id: 'c1' }); returned = await pending; });

    expect(returned).toBe(false);
    expect(result.current.toast).toBeNull();
  });
});

describe('WHIT-628 — writers still signed in', () => {
  // [B5]
  it('deleteBudget drops the budget before the server replies, and restores it + toasts on failure', async () => {
    queryClient.setQueryData(['budgets'], { c1: rollup(100), c2: rollup(50) });
    const d = deferred<{ id: string }>();
    mockApi.deleteBudget.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteBudget('c1'); });
    expect(queryClient.getQueryData(['budgets'])).toEqual({ c2: rollup(50) });

    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(queryClient.getQueryData(['budgets'])).toEqual({ c1: rollup(100), c2: rollup(50) });
    expect(returned).toBe(false);
    expect(result.current.toast).toBe('Could not remove budget. Please try again.');
  });

  // [B6]
  it('deleteBudget success keeps it removed, refreshes budgets, toasts and returns true', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['budgets'], { c1: rollup(100) });
    mockApi.deleteBudget.mockResolvedValue({ id: 'c1' });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let returned!: boolean;
    await act(async () => { returned = await result.current.deleteBudget('c1'); });

    expect(returned).toBe(true);
    expect(queryClient.getQueryData(['budgets'])).toEqual({});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['budgets'] });
    expect(result.current.toast).toBe('Groceries budget removed.');
  });

  // [B7]
  it('saveSpread success refreshes budgets, toasts, returns true; failure toasts and returns false', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Rego')]);
    mockApi.setSpread.mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('network') as never);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let ok!: boolean;
    await act(async () => { ok = await result.current.saveSpread('c1', 600, 6); });
    expect(ok).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['budgets'] });
    expect(result.current.toast).toBe('Bill spread set for Rego.');

    let failed!: boolean;
    await act(async () => { failed = await result.current.saveSpread('c1', 600, 6); });
    expect(failed).toBe(false);
    expect(result.current.toast).toBe('Could not set the bill spread. Please try again.');
  });

  // [B8]
  it('removeSpread success refreshes budgets and toasts; failure toasts', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Rego')]);
    mockApi.deleteSpread.mockResolvedValueOnce({ id: 'c1' }).mockRejectedValueOnce(new Error('network') as never);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let ok!: boolean;
    await act(async () => { ok = await result.current.removeSpread('c1'); });
    expect(ok).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['budgets'] });
    expect(result.current.toast).toBe('Bill spread removed for Rego.');

    let failed!: boolean;
    await act(async () => { failed = await result.current.removeSpread('c1'); });
    expect(failed).toBe(false);
    expect(result.current.toast).toBe('Could not remove the bill spread. Please try again.');
  });

  // [B9]
  it('saveManualRule shows the temp rule instantly, removes it on failure, and toasts the error', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['rules'], [{ id: 'r0', pattern: 'ALDI', categoryId: 'c1', isNew: false }]);
    const d = deferred<unknown>();
    mockApi.createRule.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.saveManualRule('COLES', 'c1'); });
    const optimistic = queryClient.getQueryData<{ id: string; pattern: string }[]>(['rules']) ?? [];
    expect(optimistic.map((r) => r.pattern)).toEqual(['COLES', 'ALDI']);
    expect(result.current.toast).toBe('Rule added — COLES files as Groceries.');

    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(queryClient.getQueryData<{ id: string }[]>(['rules'])?.map((r) => r.id)).toEqual(['r0']);
    expect(result.current.toast).toBe('Could not save rule. Please try again.');
  });

  // [B10]
  it('saveManualRule success swaps the temp id for the server id and keeps the NEW badge', async () => {
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    queryClient.setQueryData(['rules'], []);
    mockApi.createRule.mockResolvedValue({ id: 'srv-1', value: 'COLES', category_id: 'c1', field: 'description', operator: 'contains' } as never);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => { await result.current.saveManualRule('COLES', 'c1'); });

    const rules = queryClient.getQueryData<{ id: string; isNew: boolean }[]>(['rules']) ?? [];
    expect(rules.map((r) => r.id)).toEqual(['srv-1']);
    expect(rules[0].isNew).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['filingSuggestions'] });
  });

  // [B11]
  it('updateRule patches the rule instantly and restores the original on failure', async () => {
    const original = { id: 'r1', pattern: 'OLD', categoryId: 'c1', isNew: false, field: 'description', operator: 'contains' };
    queryClient.setQueryData(['rules'], [original]);
    queryClient.setQueryData(['categories'], [cat('c1', 'Groceries')]);
    const d = deferred<unknown>();
    mockApi.updateRule.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.updateRule('r1', 'NEW', 'c1'); });
    expect(queryClient.getQueryData<{ pattern: string }[]>(['rules'])?.[0].pattern).toBe('NEW');

    await act(async () => { d.reject(new Error('network')); await pending; });

    expect(queryClient.getQueryData(['rules'])).toEqual([original]);
    expect(result.current.toast).toBe('Could not update rule. Please try again.');
  });

  // [B12]
  it('saveGoal create shows the goal instantly and drops it on failure with a toast', async () => {
    queryClient.setQueryData(['goals'], [{ id: 'g1', target: 100 }]);
    const d = deferred<api.GoalRecord>();
    mockApi.saveGoal.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveGoal(null, { target: 200 } as never); });
    expect(queryClient.getQueryData<unknown[]>(['goals'])).toHaveLength(2);

    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(queryClient.getQueryData(['goals'])).toEqual([{ id: 'g1', target: 100 }]);
    expect(returned).toBe(false);
    expect(result.current.toast).toBe('Could not save goal. Please try again.');
  });

  // [B13]
  it('saveLoanFacts failure (signed in) restores the previous facts and toasts', async () => {
    queryClient.setQueryData(['loanFacts'], { balance: 111, rate: 5 });
    const d = deferred<api.LoanFactsInput>();
    mockApi.setLoanFacts.mockImplementation(() => d.promise);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveLoanFacts({ balance: 222, rate: 6 } as never); });
    expect(queryClient.getQueryData(['loanFacts'])).toEqual({ balance: 222, rate: 6 });

    let returned!: boolean;
    await act(async () => { d.reject(new Error('network')); returned = await pending; });

    expect(queryClient.getQueryData(['loanFacts'])).toEqual({ balance: 111, rate: 5 });
    expect(returned).toBe(false);
    expect(result.current.toast).toBe('Could not save loan details. Please try again.');
  });

  // [B14]
  it('persistPayCycle success refetches payCycle, budgets and breakdown', async () => {
    queryClient.setQueryData(['payCycle'], { length: 14, last_pay_date: '2026-06-06' });
    mockApi.setPayCycle.mockResolvedValue({ length: 30, last_pay_date: '2026-06-06' } as never);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => {
      result.current.setPayCycleLength(30);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(mockApi.setPayCycle).toHaveBeenCalledWith({ length: 30, last_pay_date: '2026-06-06' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['payCycle'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['budgets'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['breakdown'] });
  });
});
