// WHIT-639 QA — edge cases of the fake server's one-shot reply queue (once), driven through the
// REAL src/api.ts calls so each check proves what the app would actually see.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { ApiError } from '../../apiError';
import { resetAuth } from './authMock';
import { installFakeServer } from './fakeServer';
import { GROCERIES } from './categories';

const JOBS = '/transactions/uncategorized/apply-rules/jobs';
const RUNNING = { jobId: 'job-1', status: 'running', attempted: 1 };
const SUCCEEDED = { jobId: 'job-1', status: 'succeeded', attempted: 2 };

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => resetAuth());

describe('WHIT-639 QA — once() edge cases', () => {
  const server = installFakeServer();

  afterEach(() => { jest.useRealTimers(); });

  // [A1] (P0) Two requests held on one path each take their own queued reply, in arrival order —
  // the preview-then-commit pattern filingRunEdges [A15] and filingRunSaveRunner.qa [A3] rely on.
  it('[A1] two held requests on one path take the queued replies in the order they were sent', async () => {
    server.once('POST', '/categories', { status: 409, reason: 'first' });
    server.once('POST', '/categories', { body: GROCERIES });
    const held = server.hold('/categories');

    const first = api.createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }).catch((e: unknown) => e);
    const second = api.createCategory({ name: 'Groceries', bucket: 'Living', icon: 'cart' });
    await flush();
    held.release();

    expect(await first).toMatchObject({ name: 'ApiError', status: 409, serverMessage: 'first' });
    await expect(second).resolves.toEqual(GROCERIES);
  });

  // [A2] (P0) A request cut off by its own time limit while held must NOT use up a queued reply —
  // otherwise a slow poll silently eats the answer the test meant for the next one.
  it('[A2] a held request that times out leaves the queued reply for the next call', async () => {
    jest.useFakeTimers();
    await api.startApplyRulesJob(undefined);
    server.once('GET', `${JOBS}/job-1`, { body: SUCCEEDED });
    const held = server.hold(`${JOBS}/job-1`);

    const timedOut = api.getApplyRulesJob('job-1').catch((e: unknown) => e);
    await flush();
    await jest.advanceTimersByTimeAsync(6_000);
    expect(await timedOut).toMatchObject({ name: 'AbortError' });

    held.release();
    await expect(api.getApplyRulesJob('job-1')).resolves.toEqual(SUCCEEDED);
  });

  // [A3] (P0) Queues are per path: a reply queued for one job never answers another job's poll.
  it('[A3] a reply queued for job-1 is not used by job-2', async () => {
    await api.startApplyRulesJob(undefined);
    await api.startApplyRulesJob(undefined);
    server.once('GET', `${JOBS}/job-1`, 'dropped');

    await expect(api.getApplyRulesJob('job-2')).resolves.toMatchObject({ jobId: 'job-2', status: 'running' });
    await expect(api.getApplyRulesJob('job-1')).rejects.toThrow('Network request failed');
    await expect(api.getApplyRulesJob('job-1')).resolves.toMatchObject({ jobId: 'job-1', status: 'running' });
  });

  // [A4] (P1) once() takes the bare path; a request with a query string still uses it.
  it('[A4] a request with a query string uses the reply queued for its bare path', async () => {
    server.once('GET', '/transactions/search', { body: { transactions: [], truncated: true } });
    await expect(api.fetchTransactionsSearch('all', 'steven')).resolves.toEqual({ transactions: [], truncated: true });
    expect(server.requests()).toEqual([{ method: 'GET', path: '/transactions/search?tab=all&q=steven', body: undefined }]);
  });

  // [A5] (P1) A dropped write is a rejection the app sees as a lost connection, not an ApiError,
  // and it is still logged (the app did send it).
  it('[A5] a dropped POST rejects with a network TypeError and is still in the request log', async () => {
    server.once('POST', JOBS, 'dropped');
    const error = await api.startApplyRulesJob(undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(server.requests()).toEqual([{ method: 'POST', path: JOBS, body: {} }]);
  });

  // [A6] (P1) A queued reply wins over seeded data, then the seeded data comes back.
  it('[A6] a queued reply beats seeded data once, then the seeded data answers again', async () => {
    server.seed('/categories', [GROCERIES]);
    server.once('GET', '/categories', { body: [] });
    await expect(api.fetchCategories()).resolves.toEqual([]);
    await expect(api.fetchCategories()).resolves.toEqual([GROCERIES]);
  });

  // [A7] (P1) A queued error on a withReason call with no reason → no server message.
  it('[A7] a queued error with no reason gives a withReason call a null server message', async () => {
    server.once('POST', '/categories', { status: 500 });
    await expect(api.createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' })).rejects.toMatchObject({
      name: 'ApiError', status: 500, serverMessage: null,
    });
  });

  // [A8] (P1) Regression of the fail() refactor: a sticky failure still carries its reason, every time.
  it('[A8] fail() with a reason still answers every call with that reason', async () => {
    server.fail('/categories', 409, 'Taken');
    const gym = { name: 'Gym', bucket: 'Lifestyle' as const, icon: 'dumbbell' };
    await expect(api.createCategory(gym)).rejects.toMatchObject({ status: 409, serverMessage: 'Taken' });
    await expect(api.createCategory(gym)).rejects.toMatchObject({ status: 409, serverMessage: 'Taken' });
  });
});
