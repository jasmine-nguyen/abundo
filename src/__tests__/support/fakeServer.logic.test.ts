// WHIT-637 — the in-memory pretend server the app tests use instead of jest.mock('../api').
// Driven through the REAL src/api.ts calls, so it proves the fake answers the way the real code
// reads a reply, and that each call keeps its declared error style (plain / statusOnly / withReason).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { ApiError } from '../../apiError';
import { resetAuth, setAuthToken } from './authMock';
import { WIRE } from './apiWire';
import { installFakeServer } from './fakeServer';

const BASE = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';
const originalFetch = global.fetch;

const GROCERIES = { id: 'groceries', name: 'Groceries', bucket: 'Essentials', icon: 'cart', color: '#00AA00' };
const GYM = { name: 'Gym', bucket: 'Lifestyle' as const, icon: 'dumbbell' };

// Let every pending promise step run (auth token → fetch → body read) without touching timers.
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => resetAuth());

describe('WHIT-637 fake server', () => {
  const server = installFakeServer();

  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers a read with the data it was seeded with', async () => {
    server.seed('/categories', [GROCERIES]);
    await expect(api.fetchCategories()).resolves.toEqual([GROCERIES]);
  });

  it('starts every test empty — nothing seeded in an earlier test leaks in', async () => {
    await expect(api.fetchCategories()).resolves.toEqual([]);
  });

  it('a forced failure rejects in each call\'s declared error style', async () => {
    server.fail('/categories', 500);
    const plain = await api.fetchCategories().catch((error: unknown) => error);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(ApiError);
    expect((plain as Error).message).toBe('API error: 500');

    server.fail('/rules', 409, 'Rule already exists');
    await expect(api.createRule({ value: 'COLES', categoryId: 'groceries' })).rejects.toMatchObject({
      name: 'ApiError', message: 'API error: 409', status: 409, serverMessage: null,
    });
  });

  it('the three category saves carry the server\'s reason on failure', async () => {
    server.fail('/categories', 409, 'A category called Gym already exists');
    await expect(api.createCategory(GYM)).rejects.toMatchObject({
      name: 'ApiError', status: 409, serverMessage: 'A category called Gym already exists',
    });

    server.fail('/categories/gym', 404, 'No such category');
    await expect(api.updateCategory('gym', GYM)).rejects.toMatchObject({ status: 404, serverMessage: 'No such category' });
    await expect(api.deleteCategory('gym')).rejects.toMatchObject({ status: 404, serverMessage: 'No such category' });
  });

  it('a held save stays pending until release(), and still settles under fake timers', async () => {
    jest.useFakeTimers();
    const held = server.hold('/categories');
    let settled = false;
    const save = api.createCategory(GYM).then(() => { settled = true; });

    await flush();
    expect(settled).toBe(false);

    held.release();
    await flush();
    expect(settled).toBe(true);
    await save;
  });

  it('logs every request\'s method, path and body', async () => {
    server.seed('/categories', [GROCERIES]);
    await api.fetchCategories();
    await api.updateCategory('groceries', GYM);
    await api.setTransactionCategory('t1', 'groceries');

    expect(server.requests()).toEqual([
      { method: 'GET', path: '/categories', body: undefined },
      { method: 'PATCH', path: '/categories/groceries', body: GYM },
      { method: 'PATCH', path: '/transactions/t1', body: { category: 'groceries' } },
    ]);
  });

  it('not signed in → the call rejects "Not signed in" and never reaches the server', async () => {
    setAuthToken(undefined);
    await expect(api.fetchCategories()).rejects.toThrow('Not signed in');
    expect(server.requests()).toEqual([]);
  });

  it('has a route for every call in the wire list', async () => {
    // An unknown path is refused loudly, so a missing route can't pass unnoticed.
    await expect(fetch(`${BASE}/no-such-route`)).rejects.toThrow(/no route/i);

    const unrouted: string[] = [];
    for (const [name, [call]] of Object.entries(WIRE)) {
      const error = await call().then(() => null, (rejection: unknown) => rejection);
      if (error instanceof Error && /no route/i.test(error.message)) unrouted.push(name);
    }
    expect(unrouted).toEqual([]);
  });
});

describe('WHIT-639 fake server one-shot replies (once)', () => {
  const server = installFakeServer();
  const JOB_PATH = '/transactions/uncategorized/apply-rules/jobs/job-1';
  const RUNNING = { jobId: 'job-1', status: 'running', attempted: 10 };
  const SUCCEEDED = { jobId: 'job-1', status: 'succeeded', attempted: 20 };

  it('a job poll gets each queued reply once, in order, then falls back to the route', async () => {
    server.seed(JOB_PATH, RUNNING);
    server.once('GET', JOB_PATH, 'dropped');
    server.once('GET', JOB_PATH, { status: 503 });
    server.once('GET', JOB_PATH, { body: SUCCEEDED });

    const dropped = await api.getApplyRulesJob('job-1').catch((error: unknown) => error);
    expect(dropped).toBeInstanceOf(TypeError);
    expect((dropped as Error).message).toBe('Network request failed');

    await expect(api.getApplyRulesJob('job-1')).rejects.toMatchObject({
      name: 'ApiError', status: 503, serverMessage: null,
    });
    await expect(api.getApplyRulesJob('job-1')).resolves.toEqual(SUCCEEDED);
    await expect(api.getApplyRulesJob('job-1')).resolves.toEqual(RUNNING);

    expect(server.requests().filter((r) => r.method === 'GET' && r.path === JOB_PATH)).toHaveLength(4);
  });

  it('a queued reply beats a sticky failure, is keyed by method, and carries the server\'s reason', async () => {
    server.fail('/categories', 500);
    server.once('GET', '/categories', { body: [GROCERIES] });
    await expect(api.fetchCategories()).resolves.toEqual([GROCERIES]);
    await expect(api.fetchCategories()).rejects.toThrow('API error: 500');

    server.once('PUT', '/rules/r1', { status: 409 });
    await expect(api.deleteRule('r1')).resolves.toEqual({ id: 'r1' });
    await expect(api.updateRule('r1', { value: 'COLES', categoryId: 'groceries' })).rejects.toMatchObject({
      name: 'ApiError', status: 409,
    });

    server.once('POST', '/categories', { status: 409, reason: 'A category called Gym already exists' });
    await expect(api.createCategory(GYM)).rejects.toMatchObject({
      name: 'ApiError', status: 409, serverMessage: 'A category called Gym already exists',
    });
  });
});

describe('WHIT-637 fake server clean-up', () => {
  it('puts the real fetch back once the fake server\'s tests are done', () => {
    expect(global.fetch).toBe(originalFetch);
  });
});
