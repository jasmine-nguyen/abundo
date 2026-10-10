// WHIT-254 — failed deletes through the REAL deleteGoal/deleteRule writers restore cache order
// (the order maths itself is in reinsert.logic.test.ts). Here: a MIX of one succeeding + one
// failing (successful one stays gone, failed one lands in the right slot AND the boolean returns
// are honoured); a failed delete
// of the only element restores [x]; deleteGoal false-on-failure; a toast surfaces on failure;
// and a cache evicted mid-flight stays empty for both deleteGoal and deleteRule (WHIT-833).
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Rule } from '../model';
import type { GoalRecord } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { refreshInAct } from './support/renderWithQueries';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const mountAppContext = () => renderHook(() => useAppContext(), { wrapper }).result;

const goal = (id: string): GoalRecord => ({
  id, name: id, icon: 'star', direction: 'grow',
  target_amount: 100, target_date: '2027-01-01', account_id: 'up-spending',
});
const rule = (id: string): Rule => ({ id, pattern: id, categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' });

const goalIds = () => queryClient.getQueryData<GoalRecord[]>(['goals'])?.map((g) => g.id);
const ruleIds = () => queryClient.getQueryData<Rule[]>(['rules'])?.map((r) => r.id);

// Each goal delete sits at its own path, so a failure is set per id.
const failGoalDeletes = (...ids: string[]) => ids.forEach((id) => server.fail(`/goals/${id}`, 500));

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

describe('deleteGoal — one succeeds + one fails concurrently', () => {
  it('the successful predecessor stays gone; the failed row lands in the right slot; returns honoured', async () => {
    // Call order [g3(fail), g1(success)]: g3 captures its successor ids BEFORE g1 is removed,
    // so a saved integer index would splice g3 back at a stale slot -> [g2,g4,g3]. The
    // successor-anchor lands it correctly at [g2,g3,g4]. This is the fail-on-revert case.
    failGoalDeletes('g3');
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
  beforeEach(() => { failGoalDeletes('g1', 'g2', 'g3', 'g4', 'g5'); });

  it('a failed delete of the ONLY element restores [g1] and returns false + toasts', async () => {
    queryClient.setQueryData<GoalRecord[]>(['goals'], [goal('g1')]);
    const result = mountAppContext();
    let ret: boolean | undefined;
    await act(async () => { ret = await result.current.deleteGoal('g1'); });
    expect(ret).toBe(false);
    expect(goalIds()).toEqual(['g1']);
    expect(result.current.toast).toBe('Could not delete goal. Please try again.');
  });
});

// WHIT-833 decision A: one shared delete-with-rollback. If the list's cache was evicted
// mid-delete, a failed delete does NOT rebuild a partial list — the cache stays empty and
// the list reloads fresh from the server next time it's opened. Same for goals and rules.
describe('failed delete with the cache EVICTED mid-flight leaves the cache empty', () => {
  it.each([
    {
      name: 'deleteGoal', path: '/goals/g1', key: ['goals'], ids: goalIds,
      seed: () => queryClient.setQueryData<GoalRecord[]>(['goals'], [goal('g1'), goal('g2')]),
      run: (ctx: ReturnType<typeof useAppContext>) => ctx.deleteGoal('g1'),
    },
    {
      name: 'deleteRule', path: '/rules/r1', key: ['rules'], ids: ruleIds,
      seed: () => queryClient.setQueryData<Rule[]>(['rules'], [rule('r1'), rule('r2')]),
      run: (ctx: ReturnType<typeof useAppContext>) => ctx.deleteRule('r1'),
    },
  ])('$name does not put the item back into an evicted cache', async ({ path, key, ids, seed, run }) => {
    // Held reply so we can wipe the cache between the optimistic remove and the rollback.
    const held = server.hold(path);
    seed();
    const result = mountAppContext();
    let p!: Promise<unknown>;
    act(() => { p = run(result.current); });
    await refreshInAct(() => queryClient.removeQueries({ queryKey: key }));
    await act(async () => {
      held.fail('DELETE', { status: 500 });
      await p;
    });
    expect(ids()).toBeUndefined();
  });
});
