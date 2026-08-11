// WHIT-233 — the goal writes (saveGoal/deleteGoal) against the ['goals'] query cache the hub
// reads, driven through the REAL AppProvider + the singleton queryClient (like rulesWrite).
// saveGoal is one method for create (mint id + APPEND) and edit (REPLACE in place), optimistic
// then reconciled to the server row; a failure rolls the cache back. deleteGoal removes
// optimistically and reinserts AT THE ORIGINAL INDEX on failure. The cache is seeded first (as
// if the hub had loaded) so the writers' `prev` is defined. expo-crypto is auto-mocked
// (__mocks__/expo-crypto.js) so the minted id is deterministic.
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

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

// The real server echoes the id back into the saved goal; mirror that so the reconcile step
// replaces the optimistic row with an equivalent authoritative one.
function echoSave() {
  mockApi.saveGoal.mockImplementation((id: string, body: GoalWriteBody) => Promise.resolve({ id, ...body }));
}

function mountWithSeededCache(goals: GoalRecord[] = [GOAL_G1]) {
  queryClient.setQueryData<GoalRecord[]>(['goals'], goals);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

// Folded from goalsWriteEdges: seeds only when goals are given, so the un-opened-hub
// (undefined ['goals']) cases can exercise the `prev ?? []` guard.
function mount(goals?: GoalRecord[]) {
  if (goals) queryClient.setQueryData<GoalRecord[]>(['goals'], goals);
  return renderHook(() => useAppContext(), { wrapper }).result;
}

it('saveGoal(null, body) mints an id and APPENDS the new goal, then reconciles to the server row', async () => {
  echoSave();
  const result = mountWithSeededCache();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveGoal(null, NEW_BODY); });

  expect(ok).toBe(true);
  const goals = cacheGoals()!;
  expect(goals).toHaveLength(2);
  const created = goals.find((g) => g.id !== 'g1')!;
  // Assert the body fields inline (a typed union const isn't assignable to toMatchObject's
  // Record<string, unknown> param — the rest of this suite passes inline literals too).
  expect(created).toMatchObject({
    name: 'Holiday', icon: 'palm', direction: 'grow',
    target_amount: 5000, target_date: '2026-11-01', account_id: 'up-spending',
  });
  expect(created.id).toMatch(/^test-uuid-/);     // a client-minted id (the auto-mocked randomUUID)
  // The server was PUT the minted id + the body (id in the path, not the body).
  expect(mockApi.saveGoal).toHaveBeenCalledWith(created.id, NEW_BODY);
});

it('saveGoal(editId, body) REPLACES the existing goal in place (no append)', async () => {
  echoSave();
  const result = mountWithSeededCache();
  const edit: GoalWriteBody = { ...NEW_BODY, name: 'Bigger fund', target_amount: 20000 };

  await act(async () => { await result.current.saveGoal('g1', edit); });

  const goals = cacheGoals()!;
  expect(goals).toHaveLength(1);                  // replaced, not appended
  expect(goals[0]).toMatchObject({ id: 'g1', name: 'Bigger fund', target_amount: 20000 });
  expect(mockApi.saveGoal).toHaveBeenCalledWith('g1', edit);
});

it('a failed CREATE mirrors the optimistic append mid-flight, then rolls it back', async () => {
  mockApi.saveGoal.mockRejectedValue(new Error('API error: 400'));
  const result = mountWithSeededCache();

  // Observe the optimistic append reaching the cache MID-FLIGHT (before the reject) — without
  // the setQueryData the new goal never hits the cache and midCount stays 1, so this has teeth.
  let midCount: number | undefined;
  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.saveGoal(null, NEW_BODY);
    midCount = cacheGoals()?.length; // optimistic append → 2
    ok = await p;
  });

  expect(midCount).toBe(2);            // fails if the optimistic write is removed
  expect(ok).toBe(false);
  expect(cacheGoals()).toEqual([GOAL_G1]); // rolled back to the pre-save list (append dropped)
});

it('a failed EDIT rolls the cached goal back to its prior value', async () => {
  mockApi.saveGoal.mockRejectedValue(new Error('API error: 500'));
  const result = mountWithSeededCache();

  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.saveGoal('g1', { ...NEW_BODY, name: 'Renamed', target_amount: 99999 });
  });

  expect(ok).toBe(false);
  expect(cacheGoals()).toEqual([GOAL_G1]); // the prior record restored, edit discarded
});

it('deleteGoal removes the goal from the cache on success', async () => {
  mockApi.deleteGoal.mockResolvedValue({ id: 'g1' });
  const result = mountWithSeededCache();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteGoal('g1'); });

  expect(ok).toBe(true);
  expect(cacheGoals()).toEqual([]);
});

it('a failed delete reinserts the goal AT ITS ORIGINAL INDEX', async () => {
  mockApi.deleteGoal.mockRejectedValue(new Error('API error: 500'));
  const G2: GoalRecord = { ...GOAL_G1, id: 'g2', name: 'Car' };
  const G3: GoalRecord = { ...GOAL_G1, id: 'g3', name: 'Roof' };
  const result = mountWithSeededCache([GOAL_G1, G2, G3]);

  let midCount: number | undefined;
  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.deleteGoal('g2'); // the MIDDLE goal
    midCount = cacheGoals()?.length; // optimistic remove → 2
    ok = await p;
  });

  expect(midCount).toBe(2);                          // optimistically removed mid-flight
  expect(ok).toBe(false);
  expect(cacheGoals()).toEqual([GOAL_G1, G2, G3]);   // restored to the SAME order (index preserved)
});

it('deleteGoal is a no-op false when the id is not in the cache', async () => {
  const result = mountWithSeededCache();

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.deleteGoal('nope'); });

  expect(ok).toBe(false);
  expect(mockApi.deleteGoal).not.toHaveBeenCalled();
  expect(cacheGoals()).toEqual([GOAL_G1]);
});

// ===== WHIT-233 (folded from goalsWriteEdges.provider.screen.test.tsx) =====
// ADVERSARIAL edge coverage the happy-path suite above does not lock: create into an
// EMPTY/undefined ['goals'] cache (`prev ?? []`), the create reconcile swapping the optimistic
// row for a DIFFERENT server row, an edit whose id is concurrently REMOVED before the api
// settles (rollback must NOT resurrect — on failure AND success), delete of the FIRST and LAST
// element restoring order, and two concurrent successful deletes. Same AppProvider + singleton
// queryClient; the module-scope beforeEach/afterEach clear the cache between these too.

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
