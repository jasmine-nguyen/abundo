// WHIT-637 QA fix round — the held reply's abort handling: fires at the call's OWN limit
// (not earlier), a release inside the limit still delivers the data, and an aborted call is still logged.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { resetAuth } from './authMock';
import { installFakeServer } from './fakeServer';
import { GROCERIES } from './categories';

beforeEach(() => {
  resetAuth();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('WHIT-637 QA fake server: held reply vs time limit', () => {
  const server = installFakeServer();

  // [A11] a held job check fails at its own 6s limit, not before
  it('[A11] a held apply-rules job check stays pending at 5.9s and rejects at 6s', async () => {
    const started = await api.startApplyRulesJob();
    server.hold(`/transactions/uncategorized/apply-rules/jobs/${started.jobId}`);
    let outcome = 'pending';
    const check = api.getApplyRulesJob(started.jobId).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

    await jest.advanceTimersByTimeAsync(5_900);
    const before = outcome;
    await jest.advanceTimersByTimeAsync(200);
    await check;
    expect({ before, after: outcome }).toEqual({ before: 'pending', after: 'rejected' });
  });

  // [A12] releasing inside the limit delivers the data, and the limit passing later changes nothing
  it('[A12] a hold released before the limit resolves with the seeded data', async () => {
    server.seed('/categories', [GROCERIES]);
    const held = server.hold('/categories');
    const read = api.fetchCategories();
    await jest.advanceTimersByTimeAsync(10_000);
    held.release();
    await expect(read).resolves.toEqual([GROCERIES]);
    await jest.advanceTimersByTimeAsync(10_000);
  });

  // [A13] a call cut off by its time limit is still in the request log
  it('[A13] an aborted held save is still logged with its body', async () => {
    server.hold('/categories');
    const save = api.createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(15_000);
    const error = await save;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(server.requests()).toEqual([
      { method: 'POST', path: '/categories', body: { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' } },
    ]);
  });
});
