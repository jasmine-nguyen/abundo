// WHIT-762 QA — the writers now built on ruleFields / writeSpread / stripBudgetId /
// cachedCategory. Pins the exact optimistic rule rows and API bodies (classic vs multi, create vs
// edit), the spread guard + cold-cache toast, and deleteCategory's budget strip across every
// ['budgets'] entry.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';

import { AppProvider, useAppContext } from '../context';
import { queryClient } from '../queryClient';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES, SUBS } from './support/categories';

const server = installFakeServer();

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const rollup = (target: number) => ({ target, spent: 0 });
const multi = {
  conditions: [
    { field: 'merchant', operator: 'equals', value: 'Coles' },
    { field: 'description', operator: 'contains', value: 'EXPRESS' },
  ],
  logic: 'all' as const,
};
const rules = () => queryClient.getQueryData<Record<string, unknown>[]>(['rules']) ?? [];

beforeEach(() => {
  resetAuth();
  queryClient.clear();
  queryClient.setQueryData(['categories'], [GROCERIES, SUBS]);
});
afterEach(() => {
  queryClient.clear();
  jest.restoreAllMocks();
});

describe('saveManualRule — ruleFields', () => {
  // [A1]
  it('classic: the temp row has only the classic fields (trimmed), and POSTs { value, ... }', async () => {
    queryClient.setQueryData(['rules'], []);
    const held = server.hold('/rules');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.saveManualRule('  COLES  ', 'groceries', true, undefined, false); });
    expect(rules()).toEqual([{
      id: expect.stringMatching(/^tmp-/), isNew: true, pattern: 'COLES', categoryId: 'groceries', budgetExcluded: true, spread: false,
    }]);
    expect(result.current.toast).toBe('Rule added — COLES files as Groceries.');

    await act(async () => { held.release(); await pending; });
    expect(server.sent('POST', '/rules').map((r) => r.body)).toEqual([
      { value: 'COLES', categoryId: 'groceries', budgetExcluded: true, spread: false },
    ]);
  });

  // [A2]
  it('multi: the temp row carries the first condition + conditions/logic, and POSTs the conditions body', async () => {
    queryClient.setQueryData(['rules'], []);
    const held = server.hold('/rules');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.saveManualRule('ignored', 'groceries', false, multi, true); });
    expect(rules()).toEqual([{
      id: expect.stringMatching(/^tmp-/), isNew: true, pattern: 'Coles', categoryId: 'groceries', budgetExcluded: false, spread: true,
      field: 'merchant', operator: 'equals', conditions: multi.conditions, logic: 'all',
    }]);
    expect(result.current.toast).toBe('Rule added — files as Groceries.');

    await act(async () => { held.release(); await pending; });
    expect(server.sent('POST', '/rules').map((r) => r.body)).toEqual([
      { conditions: multi.conditions, logic: 'all', categoryId: 'groceries', budgetExcluded: false, spread: true },
    ]);
  });

  // [A5]
  it('a blank pattern or a missing category sends nothing and adds no row', async () => {
    queryClient.setQueryData(['rules'], []);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    await act(async () => { await result.current.saveManualRule('   ', 'groceries'); });
    await act(async () => { await result.current.saveManualRule('COLES', ''); });
    expect(server.sent('POST', '/rules')).toHaveLength(0);
    expect(rules()).toEqual([]);
  });
});

describe('updateRule — ruleFields', () => {
  const original = {
    id: 'r1', pattern: 'OLD', categoryId: 'groceries', isNew: false, budgetExcluded: false, spread: false,
    field: 'merchant', operator: 'equals', conditions: multi.conditions, logic: 'all',
  };

  // [A3]
  it("classic: keeps the rule's field/operator, nulls conditions/logic, and PUTs them through", async () => {
    queryClient.setQueryData(['rules'], [original]);
    const held = server.hold('/rules/r1');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.updateRule('r1', ' NEW ', 'subs', true, undefined, true); });
    expect(rules()).toEqual([{
      ...original, pattern: 'NEW', categoryId: 'subs', budgetExcluded: true, spread: true, conditions: null, logic: null,
    }]);
    expect(result.current.toast).toBe('Rule updated — NEW files as Subs.');

    await act(async () => { held.fail('PUT'); await pending; });
    expect(server.sent('PUT', '/rules/r1').map((r) => r.body)).toEqual([
      { value: 'NEW', categoryId: 'subs', budgetExcluded: true, spread: true, field: 'merchant', operator: 'equals' },
    ]);
    expect(rules()).toEqual([original]);
  });

  // [A4]
  it('multi: takes field/operator from the first condition and PUTs the conditions body (no field/operator)', async () => {
    const classic = { id: 'r1', pattern: 'OLD', categoryId: 'groceries', isNew: false, field: 'description', operator: 'contains' };
    queryClient.setQueryData(['rules'], [classic]);
    const held = server.hold('/rules/r1');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<void>;
    act(() => { pending = result.current.updateRule('r1', 'ignored', 'groceries', false, multi, false); });
    expect(rules()).toEqual([{
      ...classic, pattern: 'Coles', budgetExcluded: false, spread: false,
      field: 'merchant', operator: 'equals', conditions: multi.conditions, logic: 'all',
    }]);

    await act(async () => { held.fail('PUT'); await pending; });
    expect(server.sent('PUT', '/rules/r1').map((r) => r.body)).toEqual([
      { conditions: multi.conditions, logic: 'all', categoryId: 'groceries', budgetExcluded: false, spread: false },
    ]);
  });

  // [A5]
  it('a blank pattern sends nothing and leaves the rule as it was', async () => {
    queryClient.setQueryData(['rules'], [original]);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    await act(async () => { await result.current.updateRule('r1', '  ', 'groceries'); });
    expect(server.sent('PUT', '/rules/r1')).toHaveLength(0);
    expect(rules()).toEqual([original]);
  });
});

describe('saveSpread / removeSpread — writeSpread', () => {
  // [A6]
  it('saveSpread rejects a zero amount or out-of-range cycles without a request', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    const outcomes: boolean[] = [];
    await act(async () => {
      outcomes.push(await result.current.saveSpread('groceries', 0, 6));
      outcomes.push(await result.current.saveSpread('groceries', 100, 0));
      outcomes.push(await result.current.saveSpread('groceries', 100, 25));
    });
    expect(outcomes).toEqual([false, false, false]);
    expect(server.sentUnder('PUT', '/budgets')).toHaveLength(0);
    expect(result.current.toast).toBeNull();
  });

  // [A7]
  it('saveSpread accepts the exact cycle limits (1 and 24)', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    const outcomes: boolean[] = [];
    await act(async () => {
      outcomes.push(await result.current.saveSpread('groceries', 100, 1));
      outcomes.push(await result.current.saveSpread('groceries', 100, 24));
    });
    expect(outcomes).toEqual([true, true]);
    expect(server.sent('PUT', '/budgets/groceries/spread').map((r) => r.body)).toEqual([
      { amount: 100, cycles: 1 }, { amount: 100, cycles: 24 },
    ]);
  });

  // [A8]
  it('with a cold categories cache both still succeed but show no toast', async () => {
    queryClient.removeQueries({ queryKey: ['categories'] });
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let saved!: boolean;
    let removed!: boolean;
    await act(async () => {
      saved = await result.current.saveSpread('groceries', 100, 4);
      removed = await result.current.removeSpread('groceries');
    });
    expect([saved, removed]).toEqual([true, true]);
    expect(result.current.toast).toBeNull();
  });
});

describe('deleteCategory / deleteBudget — stripBudgetId', () => {
  // [A9]
  it('deleteCategory drops the id from every [budgets] entry, and restores them all on failure', async () => {
    queryClient.setQueryData(['budgets'], { groceries: rollup(100), subs: rollup(50) });
    queryClient.setQueryData(['budgets', 'prev'], { groceries: rollup(80) });
    queryClient.setQueryData(['budgets', 'other'], { subs: rollup(9) });
    const held = server.hold('/categories/groceries');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteCategory('groceries'); });
    expect(queryClient.getQueryData(['budgets'])).toEqual({ subs: rollup(50) });
    expect(queryClient.getQueryData(['budgets', 'prev'])).toEqual({});
    expect(queryClient.getQueryData(['budgets', 'other'])).toEqual({ subs: rollup(9) });

    let returned!: boolean;
    await act(async () => { held.fail('DELETE'); returned = await pending; });
    expect(returned).toBe(false);
    expect(queryClient.getQueryData(['budgets'])).toEqual({ groceries: rollup(100), subs: rollup(50) });
    expect(queryClient.getQueryData(['budgets', 'prev'])).toEqual({ groceries: rollup(80) });
    expect(queryClient.getQueryData(['budgets', 'other'])).toEqual({ subs: rollup(9) });
  });

  // [A9]
  it('deleteBudget drops the id from every [budgets] entry, not just the first', async () => {
    queryClient.setQueryData(['budgets'], { groceries: rollup(100) });
    queryClient.setQueryData(['budgets', 'prev'], { groceries: rollup(80), subs: rollup(5) });
    const held = server.hold('/budgets/groceries');
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.deleteBudget('groceries'); });
    expect(queryClient.getQueryData(['budgets'])).toEqual({});
    expect(queryClient.getQueryData(['budgets', 'prev'])).toEqual({ subs: rollup(5) });
    await act(async () => { held.release(); await pending; });
    expect(result.current.toast).toBe('Groceries budget removed.');
  });
});
