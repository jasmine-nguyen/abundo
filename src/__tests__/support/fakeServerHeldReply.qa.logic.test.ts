// WHIT-651 QA — the hold/once behaviours the moved sign-out suites (sessionGuard*, saveMilestonesSignOut)
// lean on, driven through the REAL src/api.ts calls. If any of these drift, those suites keep passing
// on the wrong reply (a success where they meant a failure), so each is pinned here.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { ApiError } from '../../apiError';
import { resetAuth } from './authMock';
import { installFakeServer } from './fakeServer';

const CAP = 'You can have up to 50 categories';
const GYM = { name: 'Gym', bucket: 'Lifestyle' as const, icon: 'dumbbell' };
const PLAN = [{ id: 'c', label: 'Client-minted', target: 1 }] as never;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => resetAuth());

describe('WHIT-651 QA — held replies used by the sign-out suites', () => {
  const server = installFakeServer();

  // [A1] (P0) saveMilestonesSignOut / sessionGuardSaveRunnerQa queue the failure AFTER the save is in flight.
  it('[A1] a dropped reply queued while the request is held is the one it gets on release', async () => {
    const held = server.hold('/milestones');
    const save = api.setMilestones(PLAN).then(() => 'resolved', (e: unknown) => e);
    await flush();
    expect(server.sent('PUT', '/milestones')).toHaveLength(1);

    server.once('PUT', '/milestones', 'dropped');
    held.release();

    const outcome = await save;
    expect(outcome).toBeInstanceOf(TypeError);
    expect((outcome as Error).message).toBe('Network request failed');
  });

  // [A2] (P0) sessionGuardRollbacks [A23]: hold + once(400, reason) + release is a held withReason refusal.
  it('[A2] a held create queued with a 400 + reason rejects as an ApiError carrying the reason', async () => {
    const held = server.hold('/categories');
    server.once('POST', '/categories', { status: 400, reason: CAP });
    const create = api.createCategory(GYM).then(() => 'resolved', (e: unknown) => e);
    await flush();
    held.release();

    const outcome = await create;
    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ status: 400, serverMessage: CAP, message: 'API error: 400' });
  });

  // [A3] (P0) sessionGuardRollbacks holds '/goals/g1' for both a PUT (saveGoal) and a DELETE (deleteGoal).
  it('[A3] a hold is by path: it keeps both the PUT and the DELETE on that path waiting', async () => {
    const held = server.hold('/goals/g1');
    let settled = 0;
    const save = api.saveGoal('g1', { target: 200 } as never).then(() => { settled += 1; });
    const remove = api.deleteGoal('g1').then(() => { settled += 1; });
    await flush();
    expect(settled).toBe(0);

    held.release();
    await Promise.all([save, remove]);
    expect(settled).toBe(2);
  });

  // [A4] (P1) sessionGuardSaveRunner holds '/transactions' (batch) and '/transactions/t1' (fields) separately.
  it('[A4] holding the batch path does not hold a single charge, and holding a charge does not hold the batch', async () => {
    const batch = server.hold('/transactions');
    await expect(api.setTransactionFields('t1', { notes: 'n' } as never)).resolves.toMatchObject({ transaction_id: 't1' });
    batch.release();

    const single = server.hold('/transactions/t1');
    await expect(api.setTransactionCategories([{ id: 't1', category: 'c1' }])).resolves.toEqual({
      results: [{ id: 't1', status: 'updated' }],
    });
    single.release();
  });

  // [A5] (P1) a held save with nothing queued settles with the route's normal success once released.
  it('[A5] a held save with no queued reply resolves with the echoed plan on release, and logs its body', async () => {
    const held = server.hold('/milestones');
    const save = api.setMilestones(PLAN);
    await flush();
    held.release();

    await expect(save).resolves.toEqual(PLAN);
    expect(server.sent('PUT', '/milestones')).toEqual([{ method: 'PUT', path: '/milestones', body: { milestones: PLAN } }]);
  });
});
