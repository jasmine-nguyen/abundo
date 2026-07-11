// WHIT-233 — ADVERSARIAL edge coverage for the goal writes (saveGoal/deleteGoal) that the
// implementer's goalsWrite.provider.screen.test.tsx does not lock: create into an EMPTY/undefined
// ['goals'] cache (un-opened hub, `prev ?? []`), the create reconcile swapping the optimistic row
// for a DIFFERENT server row (no duplicate), an edit whose id is concurrently REMOVED before the
// api settles (rollback must NOT resurrect — both on failure AND success), delete of the FIRST and
// LAST element restoring order, and two concurrent successful deletes. Driven through the REAL
// AppProvider + the singleton queryClient, like goalsWrite. expo-crypto auto-mocked.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { GoalRecord, GoalWriteBody } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const GOAL_G1: GoalRecord = {
  id: 'g1', name: 'Emergency fund', icon: 'umbrella', direction: 'grow',
  target_amount: 10000, target_date: '2026-12-01', account_id: 'up-spending',
};
const NEW_BODY: GoalWriteBody = {
  name: 'Holiday', icon: 'palm', direction: 'grow',
  target_amount: 5000, target_date: '2026-11-01', account_id: 'up-spending',
};

const cacheGoals = () => queryClient.getQueryData<GoalRecord[]>(['goals']);
const echoSave = () =>
  mockApi.saveGoal.mockImplementation((id: string, body: GoalWriteBody) => Promise.resolve({ id, ...body }));

function mount(goals?: GoalRecord[]) {
  if (goals) queryClient.setQueryData<GoalRecord[]>(['goals'], goals);
  return renderHook(() => useAppContext(), { wrapper }).result;
}

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

// [G1] create with NO ['goals'] cache entry yet (hub never opened) — the `prev ?? []` guard.
it('saveGoal(null) into an EMPTY/undefined cache seeds a one-item list (prev ?? [])', async () => {
  echoSave();
  const result = mount(); // deliberately NOT seeded → getQueryData(['goals']) is undefined
  expect(cacheGoals()).toBeUndefined();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveGoal(null, NEW_BODY); });

  expect(ok).toBe(true);
  const goals = cacheGoals()!;
  expect(goals).toHaveLength(1);
  expect(goals[0]).toMatchObject({ ...NEW_BODY });
  expect(goals[0].id).toMatch(/^test-uuid-/);
});

// [G2] on success the optimistic row is SWAPPED for the server's row (same id) — not left beside it.
it('create reconciles the optimistic row to the server row by id (no duplicate, server fields win)', async () => {
  // Server echoes the id but returns an authoritative row that DIFFERS from the optimistic one.
  mockApi.saveGoal.mockImplementation((id: string, body: GoalWriteBody) =>
    Promise.resolve({ id, ...body, name: 'Server Holiday', baseline: 250 }));
  const result = mount([GOAL_G1]);

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveGoal(null, NEW_BODY); });

  expect(ok).toBe(true);
  const goals = cacheGoals()!;
  expect(goals).toHaveLength(2); // g1 + the one created row — never two rows for the new id
  const created = goals.filter((g) => g.id !== 'g1');
  expect(created).toHaveLength(1);
  expect(created[0].name).toBe('Server Holiday'); // reconciled to the server row, not the optimistic 'Holiday'
  expect(created[0].baseline).toBe(250);          // a server-only field made it into the cache
});

// [G3] an edit whose id is concurrently REMOVED before the api rejects — rollback must NOT resurrect.
it('a failed EDIT does NOT resurrect a goal that was concurrently deleted mid-flight', async () => {
  mockApi.saveGoal.mockRejectedValue(new Error('API error: 500'));
  const result = mount([GOAL_G1]);

  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.saveGoal('g1', { ...NEW_BODY, name: 'Renamed' });
    queryClient.setQueryData<GoalRecord[]>(['goals'], []); // a concurrent delete lands
    ok = await p;
  });

  expect(ok).toBe(false);
  expect(cacheGoals()).toEqual([]); // rollback maps over the (now empty) list — g1 stays gone
});

// [G4] same race, but the api SUCCEEDS — the server row must also not resurrect a deleted id.
it('a succeeded EDIT does NOT resurrect a goal that was concurrently deleted mid-flight', async () => {
  echoSave();
  const result = mount([GOAL_G1]);

  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.saveGoal('g1', { ...NEW_BODY, name: 'Renamed' });
    queryClient.setQueryData<GoalRecord[]>(['goals'], []); // a concurrent delete lands
    ok = await p;
  });

  expect(ok).toBe(true);
  expect(cacheGoals()).toEqual([]); // the reconcile map finds no g1 to swap — stays gone
});

// [G5] delete of the FIRST element, rolled back, restores it at index 0.
it('a failed delete of the FIRST goal reinserts it at index 0 (order preserved)', async () => {
  mockApi.deleteGoal.mockRejectedValue(new Error('API error: 500'));
  const G2: GoalRecord = { ...GOAL_G1, id: 'g2' };
  const G3: GoalRecord = { ...GOAL_G1, id: 'g3' };
  const result = mount([GOAL_G1, G2, G3]);

  await act(async () => { await result.current.deleteGoal('g1'); });
  expect(cacheGoals()).toEqual([GOAL_G1, G2, G3]);
});

// [G6] delete of the LAST element, rolled back, restores it at the end.
it('a failed delete of the LAST goal reinserts it at the end (order preserved)', async () => {
  mockApi.deleteGoal.mockRejectedValue(new Error('API error: 500'));
  const G2: GoalRecord = { ...GOAL_G1, id: 'g2' };
  const G3: GoalRecord = { ...GOAL_G1, id: 'g3' };
  const result = mount([GOAL_G1, G2, G3]);

  await act(async () => { await result.current.deleteGoal('g3'); });
  expect(cacheGoals()).toEqual([GOAL_G1, G2, G3]);
});

// [G7] two concurrent successful deletes both land — the survivor is correct.
it('two concurrent deletes both remove their goal (second delete sees the first\'s cache write)', async () => {
  mockApi.deleteGoal.mockResolvedValue({ id: 'x' });
  const G2: GoalRecord = { ...GOAL_G1, id: 'g2' };
  const G3: GoalRecord = { ...GOAL_G1, id: 'g3' };
  const result = mount([GOAL_G1, G2, G3]);

  let a: boolean | undefined, b: boolean | undefined;
  await act(async () => {
    const p1 = result.current.deleteGoal('g1');
    const p2 = result.current.deleteGoal('g3');
    [a, b] = await Promise.all([p1, p2]);
  });

  expect(a).toBe(true);
  expect(b).toBe(true);
  expect(cacheGoals()).toEqual([G2]); // both removed, the middle survives
});
