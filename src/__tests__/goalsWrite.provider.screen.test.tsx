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

// The real server echoes the id back into the saved goal, and returns every checkpoint WITH an
// id (minting any the client omitted — WHIT-476). Mirror both so the reconcile step replaces the
// optimistic row with an equivalent authoritative one.
function serverEcho(id: string, body: GoalWriteBody, extra: Partial<GoalRecord> = {}): GoalRecord {
  const checkpoints = body.checkpoints?.map((cp) => ({ ...cp, id: cp.id ?? 'server-minted' }));
  return { id, ...body, checkpoints, ...extra };
}

function echoSave() {
  mockApi.saveGoal.mockImplementation((id: string, body: GoalWriteBody) => Promise.resolve(serverEcho(id, body)));
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
    Promise.resolve(serverEcho(id, body, { name: 'Server Holiday', baseline: 250 })));
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

// WHIT-476 — checkpoint ids must exist BEFORE the optimistic row lands in the cache. A
// GoalRecord promises every checkpoint has a permanent id and the celebration keys on it, so
// the writer mints any the caller omitted (like the goal id) and sends the SAME ids on — the
// optimistic row and the row the server saves can never disagree about them.
it('saveGoal mints ids for id-less checkpoints, in the cache AND in the body it sends', async () => {
  echoSave();
  const result = mount([GOAL_G1]);

  // Read the cache MID-FLIGHT (before the server replies) — that optimistic row is the one
  // that must already carry ids; by the time the save resolves it has been replaced.
  let midIds: (string | undefined)[] | undefined;
  await act(async () => {
    const pending = result.current.saveGoal(null, {
      ...NEW_BODY,
      checkpoints: [{ label: 'First £1k', amount: 1000 }, { label: 'Halfway', amount: 2500, id: 'kept-1' }],
    });
    midIds = cacheGoals()!.find((g) => g.name === 'Holiday')!.checkpoints!.map((cp) => cp.id);
    await pending;
  });

  const [, sentBody] = mockApi.saveGoal.mock.calls[0] as [string, GoalWriteBody];
  const sent = sentBody.checkpoints!;
  expect(sent[0].id).toMatch(/^test-uuid-/);    // client-minted (the auto-mocked randomUUID)
  expect(sent[1].id).toBe('kept-1');            // a supplied id is never re-minted

  // The ids the OPTIMISTIC row carried mid-flight are the same ones sent — the cache must
  // never hold an id-less checkpoint, even for the instant before the server replies.
  expect(midIds).toEqual(sent.map((cp) => cp.id));
});

// ===== WHIT-476 QA GAPS — the checkpoint ladder through saveGoal =====
// The implementer's test above locks "an id-less rung gets a minted id, a supplied id is kept,
// and the cache row and the sent body agree". These lock what it does not: the mint being
// PER-RUNG, the server's ladder winning at reconcile, the rollback restoring the OLD ladder,
// and the whole-record REPLACE dropping a ladder the caller didn't resend.

// A goal already carrying a saved ladder — the "edit an existing goal" starting point.
const GOAL_WITH_LADDER: GoalRecord = {
  ...GOAL_G1,
  checkpoints: [
    { id: 'saved-1', label: 'First $1k', amount: 1000 },
    { id: 'saved-2', label: 'Halfway', amount: 5000 },
  ],
};

// [B1] Two id-less rungs must get two DIFFERENT ids. A single mint hoisted out of the map
// would give both the same id, and the once-ever celebration marker (a later slice) keys on
// it — one rung would silently mark the other's celebration done.
it('mints a SEPARATE id for every id-less checkpoint', async () => {
  echoSave();
  const result = mount([GOAL_G1]);

  await act(async () => {
    await result.current.saveGoal(null, {
      ...NEW_BODY,
      checkpoints: [{ label: 'First', amount: 1000 }, { label: 'Second', amount: 2000 }, { label: 'Third', amount: 3000 }],
    });
  });

  const [, sentBody] = mockApi.saveGoal.mock.calls[0] as [string, GoalWriteBody];
  const ids = sentBody.checkpoints!.map((cp) => cp.id);
  expect(new Set(ids).size).toBe(3);
  ids.forEach((id) => expect(id).toMatch(/^test-uuid-/));
});

// [B2] The server owns the ids. If it returns a ladder that DIFFERS from the optimistic mint
// (it minted its own, or dropped one), the reconcile must leave the SERVER's ladder in the
// cache — not the client's guess, which would make the celebration key on an id that was
// never stored.
it('reconcile replaces the optimistically minted ladder with the SERVER ladder', async () => {
  mockApi.saveGoal.mockImplementation((id: string, body: GoalWriteBody) =>
    Promise.resolve({
      ...serverEcho(id, body),
      checkpoints: [{ id: 'srv-1', label: 'First', amount: 1000 }],   // server's own ids, one rung
    }));
  const result = mount([GOAL_G1]);

  await act(async () => {
    await result.current.saveGoal(null, {
      ...NEW_BODY,
      checkpoints: [{ label: 'First', amount: 1000 }, { label: 'Second', amount: 2000 }],
    });
  });

  const created = cacheGoals()!.find((g) => g.name === 'Holiday')!;
  expect(created.checkpoints).toEqual([{ id: 'srv-1', label: 'First', amount: 1000 }]);
});

// [B3] A failed save must restore the PRE-EDIT ladder, not leave the optimistic one (whose
// freshly minted ids the server never saw) sitting in the cache.
it('a failed edit rolls the ladder back to the previously SAVED checkpoints', async () => {
  mockApi.saveGoal.mockRejectedValue(new Error('API error: 500'));
  const result = mountWithSeededCache([GOAL_WITH_LADDER]);

  let midIds: (string | undefined)[] | undefined;
  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.saveGoal('g1', {
      ...NEW_BODY,
      checkpoints: [{ label: 'Brand new rung', amount: 2000 }],
    });
    midIds = cacheGoals()![0].checkpoints?.map((cp) => cp.id);   // optimistic ladder mid-flight
    ok = await p;
  });

  expect(midIds).toEqual([expect.stringMatching(/^test-uuid-/)]);  // the optimistic write happened
  expect(ok).toBe(false);
  expect(cacheGoals()).toEqual([GOAL_WITH_LADDER]);                // old ladder + ids restored whole
});

// [B4] TRIPWIRE. A goal save is a whole-record REPLACE (server side too — see
// tests/lambda_api/test_goals.py [A3]), so an edit that does NOT resend `checkpoints` drops the
// saved ladder from the cached row — the writer never carries one forward on the caller's
// behalf. EVERY caller must therefore resend the full list. This is the one test that pins
// that division of labour.
it('an edit that omits checkpoints: client drops them optimistically, the server (B) restores them', async () => {
  // WHIT-476 option B: saveGoal is a passthrough — it sends exactly what the caller gave and
  // does NOT carry the ladder forward, so an omitting edit blanks it in the instant on-screen
  // row. But the server keeps an omitted ladder and echoes it back, so the reconcile restores
  // it. (Simulate the B server here: when the body omits checkpoints, return the stored ones.)
  mockApi.saveGoal.mockImplementation((id: string, body: GoalWriteBody) =>
    Promise.resolve({ ...serverEcho(id, body), checkpoints: GOAL_WITH_LADDER.checkpoints }));
  const result = mountWithSeededCache([GOAL_WITH_LADDER]);

  let midLadder: unknown;
  await act(async () => {
    const p = result.current.saveGoal('g1', { ...NEW_BODY, name: 'Renamed' });
    midLadder = cacheGoals()![0].checkpoints;   // the OPTIMISTIC row, before the server answers
    await p;
  });

  const [, sentBody] = mockApi.saveGoal.mock.calls[0] as [string, GoalWriteBody];
  expect(sentBody.checkpoints).toBeUndefined();          // client invents nothing on the way out
  expect(midLadder).toBeUndefined();                     // and carries nothing forward optimistically
  expect(cacheGoals()![0].name).toBe('Renamed');
  expect(cacheGoals()![0].checkpoints).toEqual(GOAL_WITH_LADDER.checkpoints);  // server restored it
});
