// WHIT-254 — the WIRING guard: fires two FAILED deletes concurrently through the REAL
// deleteGoal / deleteRule writers (AppProvider + singleton queryClient) and asserts the cache
// order is restored. This is the fail-on-revert of the production change — the old code
// reinserted at a saved integer index, which misplaces a row when the sibling delete already
// shortened the list, so these go red if the writers revert to index-splice. The pure ordering
// math (every interleaving, adjacency) is covered exhaustively in reinsert.logic.test.ts; here
// we only prove the writers capture the successor ids and route rollback through reinsertBefore.
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

const goalIds = () => queryClient.getQueryData<GoalRecord[]>(['goals'])!.map((g) => g.id);
const ruleIds = () => queryClient.getQueryData<Rule[]>(['rules'])!.map((r) => r.id);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

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
