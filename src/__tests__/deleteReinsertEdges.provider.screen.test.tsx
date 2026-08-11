// WHIT-254 — adversarial WIRING coverage beyond deleteReinsert.provider.screen.test.tsx
// (which does two-failed-delete gap+adjacent for goal & rule). Here: three concurrent
// failed goal deletes; a MIX of one succeeding + one failing (successful one stays gone,
// failed one lands in the right slot AND the boolean returns are honoured); a failed delete
// of the only element restores [x]; deleteGoal false-on-failure; a toast surfaces on failure;
// and the deleteRule cache-evicted-mid-flight asymmetry vs deleteGoal's `prev ?? []`.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Rule } from '../context';
import type { GoalRecord } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;
const mountAppContext = () => renderHook(() => useAppContext(), { wrapper }).result;

const goal = (id: string): GoalRecord => ({
  id, name: id, icon: 'star', direction: 'grow',
  target_amount: 100, target_date: '2027-01-01', account_id: 'up-spending',
});
const rule = (id: string): Rule => ({ id, pattern: id, categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' });

const goalIds = () => queryClient.getQueryData<GoalRecord[]>(['goals'])?.map((g) => g.id);
const ruleIds = () => queryClient.getQueryData<Rule[]>(['rules'])?.map((r) => r.id);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

describe('deleteGoal — three concurrent failed deletes restore order', () => {
  beforeEach(() => { mockApi.deleteGoal.mockRejectedValue(new Error('API error: 500')); });

  it('an adjacent chain (g2+g3+g4) rolls back to [g1..g5]', async () => {
    queryClient.setQueryData<GoalRecord[]>(['goals'], ['g1', 'g2', 'g3', 'g4', 'g5'].map(goal));
    const result = mountAppContext();
    await act(async () => {
      await Promise.all([
        result.current.deleteGoal('g2'),
        result.current.deleteGoal('g3'),
        result.current.deleteGoal('g4'),
      ]);
    });
    expect(goalIds()).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
  });
});

describe('deleteGoal — one succeeds + one fails concurrently', () => {
  it('the successful predecessor stays gone; the failed row lands in the right slot; returns honoured', async () => {
    // Call order [g3(fail), g1(success)]: g3 captures its successor ids BEFORE g1 is removed,
    // so a saved integer index would splice g3 back at a stale slot -> [g2,g4,g3]. The
    // successor-anchor lands it correctly at [g2,g3,g4]. This is the fail-on-revert case.
    mockApi.deleteGoal.mockImplementation(async (id: string) => {
      if (id === 'g3') throw new Error('API error: 500');
      return undefined as never;
    });
    queryClient.setQueryData<GoalRecord[]>(['goals'], ['g1', 'g2', 'g3', 'g4'].map(goal));
    const result = mountAppContext();
    let returns: boolean[] = [];
    await act(async () => {
      returns = await Promise.all([result.current.deleteGoal('g3'), result.current.deleteGoal('g1')]);
    });
    expect(returns).toEqual([false, true]); // g3 failed, g1 succeeded
    expect(goalIds()).toEqual(['g2', 'g3', 'g4']); // g1 gone, g3 restored in place
  });
});

describe('deleteGoal — failure edges', () => {
  beforeEach(() => { mockApi.deleteGoal.mockRejectedValue(new Error('API error: 500')); });

  it('a failed delete of the ONLY element restores [g1] and returns false + toasts', async () => {
    queryClient.setQueryData<GoalRecord[]>(['goals'], [goal('g1')]);
    const result = mountAppContext();
    let ret: boolean | undefined;
    await act(async () => { ret = await result.current.deleteGoal('g1'); });
    expect(ret).toBe(false);
    expect(goalIds()).toEqual(['g1']);
    expect(result.current.toast).toBe('Could not delete goal. Please try again.');
  });

  it('restores the removed goal even if the goals cache is EVICTED mid-flight (prev ?? [])', async () => {
    // Deferred reject so we can wipe the cache between the optimistic remove and the rollback.
    let reject!: (e: Error) => void;
    mockApi.deleteGoal.mockImplementation(() => new Promise((_res, rej) => { reject = rej; }));
    queryClient.setQueryData<GoalRecord[]>(['goals'], [goal('g1'), goal('g2')]);
    const result = mountAppContext();
    let p!: Promise<boolean>;
    act(() => { p = result.current.deleteGoal('g1'); });      // optimistic remove -> [g2]
    act(() => { queryClient.removeQueries({ queryKey: ['goals'] }); }); // cache evicted mid-flight
    await act(async () => { reject(new Error('API error: 500')); await p; });
    // deleteGoal's `prev ?? []` still rebuilds a list holding the removed goal.
    expect(goalIds()).toEqual(['g1']);
  });
});

describe('deleteRule — cache evicted mid-flight is a NO-OP (asymmetry vs deleteGoal)', () => {
  it('patchRules drops the rollback when the rules cache was evicted, losing the rule', async () => {
    // Documents the current behaviour: patchRules is `prev ? fn(prev) : prev`, so a rollback
    // against an evicted (undefined) cache is silently skipped — the failed rule delete is NOT
    // restored. deleteGoal recovers here; deleteRule does not. Flagged in the critique.
    let reject!: (e: Error) => void;
    mockApi.deleteEnrichment.mockImplementation(() => new Promise((_res, rej) => { reject = rej; }));
    queryClient.setQueryData<Rule[]>(['rules'], [rule('r1'), rule('r2')]);
    const result = mountAppContext();
    let p!: Promise<void>;
    act(() => { p = result.current.deleteRule('r1'); });
    act(() => { queryClient.removeQueries({ queryKey: ['rules'] }); });
    await act(async () => { reject(new Error('API error: 500')); await p; });
    expect(ruleIds()).toBeUndefined(); // rule NOT restored — cache stays evicted
  });
});

// ===== WHIT-254 (folded from deleteReinsert.provider.screen.test.tsx) =====
// The WIRING guard: two FAILED deletes fired concurrently through the REAL deleteGoal/deleteRule
// writers must restore cache order. Fail-on-revert of the production change — the old code
// reinserted at a saved integer index, which misplaces a row when the sibling delete already
// shortened the list, so these go red if the writers revert to index-splice. Same AppProvider +
// singleton queryClient + helpers as above; the module-scope beforeEach/afterEach clear the cache
// between these too. (Reuses this file's goalIds/ruleIds — the `?.map` form covers the same asserts.)

describe('deleteGoal — two failed deletes at once restore order', () => {
  beforeEach(() => { mockApi.deleteGoal.mockRejectedValue(new Error('API error: 500')); });

  it('a GAP pair (g1 + g3) rolls back to [g1,g2,g3,g4]', async () => {
    queryClient.setQueryData<GoalRecord[]>(['goals'], [goal('g1'), goal('g2'), goal('g3'), goal('g4')]);
    const result = mountAppContext();
    await act(async () => {
      await Promise.all([result.current.deleteGoal('g1'), result.current.deleteGoal('g3')]);
    });
    expect(goalIds()).toEqual(['g1', 'g2', 'g3', 'g4']);
  });

  it('an ADJACENT pair (g2 + g3) rolls back to [g1,g2,g3,g4]', async () => {
    queryClient.setQueryData<GoalRecord[]>(['goals'], [goal('g1'), goal('g2'), goal('g3'), goal('g4')]);
    const result = mountAppContext();
    await act(async () => {
      await Promise.all([result.current.deleteGoal('g2'), result.current.deleteGoal('g3')]);
    });
    expect(goalIds()).toEqual(['g1', 'g2', 'g3', 'g4']);
  });
});

describe('deleteRule — two failed deletes at once restore order', () => {
  beforeEach(() => { mockApi.deleteEnrichment.mockRejectedValue(new Error('API error: 500')); });

  it('a GAP pair (r1 + r3) rolls back to [r1,r2,r3,r4]', async () => {
    queryClient.setQueryData<Rule[]>(['rules'], [rule('r1'), rule('r2'), rule('r3'), rule('r4')]);
    const result = mountAppContext();
    await act(async () => {
      await Promise.all([result.current.deleteRule('r1'), result.current.deleteRule('r3')]);
    });
    expect(ruleIds()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('an ADJACENT pair (r2 + r3) rolls back to [r1,r2,r3,r4]', async () => {
    queryClient.setQueryData<Rule[]>(['rules'], [rule('r1'), rule('r2'), rule('r3'), rule('r4')]);
    const result = mountAppContext();
    await act(async () => {
      await Promise.all([result.current.deleteRule('r2'), result.current.deleteRule('r3')]);
    });
    expect(ruleIds()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});
