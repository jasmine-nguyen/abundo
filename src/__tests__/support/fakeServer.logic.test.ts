// WHIT-637 — the in-memory pretend server the app tests use instead of jest.mock('../api').
// Driven through the REAL src/api.ts calls, so it proves the fake answers the way the real code
// reads a reply, and that each call keeps its declared error style (plain / statusOnly / withReason).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { ApiError } from '../../apiError';
import { resetAuth, setAuthToken } from './authMock';
import { WIRE } from './apiWire';
import { installFakeServer, drainMicrotasks } from './fakeServer';
import { ESSENTIAL_GROCERIES } from './categories';

const BASE = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';
const originalFetch = global.fetch;

const GYM = { name: 'Gym', bucket: 'Lifestyle' as const, icon: 'dumbbell' };
const JOBS = '/transactions/uncategorized/apply-rules/jobs';
const JOB_PATH = `${JOBS}/job-1`;
const RUNNING = { jobId: 'job-1', status: 'running', attempted: 10 };
const SUCCEEDED = { jobId: 'job-1', status: 'succeeded', attempted: 20 };
const COLES = { value: 'COLES', categoryId: 'groceries' };
const PLAN = [{ id: 'c', label: 'Client-minted', target: 1 }] as never;
const CAP = 'You can have up to 50 categories';
const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

beforeEach(() => resetAuth());
afterEach(() => { jest.useRealTimers(); });

describe('WHIT-637 fake server', () => {
  const server = installFakeServer();

  it('answers a read with the data it was seeded with', async () => {
    server.seed('/categories', [ESSENTIAL_GROCERIES]);
    await expect(api.fetchCategories()).resolves.toEqual([ESSENTIAL_GROCERIES]);
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

    await drainMicrotasks();
    expect(settled).toBe(false);

    held.release();
    await drainMicrotasks();
    expect(settled).toBe(true);
    await save;
  });

  it('WHIT-659 held.fail(method) releases a held save as a lost connection, then the path answers normally', async () => {
    const held = server.hold('/milestones');
    const save = api.setMilestones([]).catch((error: unknown) => error);

    await drainMicrotasks();
    held.fail('PUT');

    const dropped = await save;
    expect(dropped).toBeInstanceOf(TypeError);
    expect((dropped as Error).message).toBe('Network request failed');

    await expect(api.setMilestones([])).resolves.toEqual([]);
    expect(server.sent('PUT', '/milestones')).toHaveLength(2);
  });

  it('WHIT-659 held.fail(method, reply) releases a held save with that status and the server\'s reason', async () => {
    const held = server.hold('/categories');
    const save = api.createCategory(GYM).catch((error: unknown) => error);

    await drainMicrotasks();
    held.fail('POST', { status: 400, reason: 'Name is required' });

    const rejected = await save;
    expect(rejected).toBeInstanceOf(ApiError);
    expect(rejected).toMatchObject({ status: 400, serverMessage: 'Name is required' });
  });

  it('logs every request\'s method, path and body', async () => {
    server.seed('/categories', [ESSENTIAL_GROCERIES]);
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

  it('a seeded path answers a call that adds a query string, and the log keeps the query', async () => {
    const budgets = { groceries: { target: 100, spent: 40 } };
    server.seed('/budgets', budgets);
    await expect(api.fetchBudgets(14)).resolves.toEqual(budgets);
    expect(server.requests()).toEqual([{ method: 'GET', path: '/budgets?days=14', body: undefined }]);

    server.fail('/budgets', 503);
    await expect(api.fetchBudgets(14)).rejects.toThrow('API error: 503');
  });

  it('replies are copies: changing a reply or the seeded object leaves the store alone', async () => {
    const seeded = [{ ...ESSENTIAL_GROCERIES }];
    server.seed('/categories', seeded);
    (seeded[0] as { name: string }).name = 'Changed after seeding';

    const first = await api.fetchCategories();
    (first[0] as { name: string }).name = 'Changed by the app';

    await expect(api.fetchCategories()).resolves.toEqual([ESSENTIAL_GROCERIES]);
  });

  it('create → update → delete a category is reflected in the next read', async () => {
    server.seed('/categories', [ESSENTIAL_GROCERIES]);
    const created = await api.createCategory(GYM);
    expect(created).toMatchObject({ id: 'gym', ...GYM });
    expect((await api.fetchCategories()).map((c) => c.id)).toEqual(['groceries', 'gym']);

    await api.updateCategory('gym', { ...GYM, name: 'Gym & Pool' });
    expect((await api.fetchCategories()).find((c) => c.id === 'gym')?.name).toBe('Gym & Pool');

    await api.deleteCategory('gym');
    await expect(api.fetchCategories()).resolves.toEqual([ESSENTIAL_GROCERIES]);
  });

  it('a created rule and a saved milestone plan are read back', async () => {
    const rule = await api.createRule(COLES);
    expect(rule.id).toBeTruthy();
    await expect(api.listRules()).resolves.toEqual([rule]);

    const plan = [{ id: 'm1', label: 'Half way', amount: 250000 }] as unknown as Parameters<typeof api.setMilestones>[0];
    await api.setMilestones(plan);
    await expect(api.fetchMilestones()).resolves.toEqual(plan);
  });

  it('a started apply-rules job is readable by its id; an unknown id rejects 404', async () => {
    const started = await api.startApplyRulesJob();
    expect(started).toMatchObject({ status: 'running' });
    await expect(api.getApplyRulesJob(started.jobId)).resolves.toMatchObject({ jobId: started.jobId, status: 'running' });

    const missing = await api.getApplyRulesJob('no-such-job').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ApiError);
    expect(missing).toMatchObject({ status: 404, message: 'API error: 404' });
  });

  it('a failure on one path leaves the paths above and beside it working', async () => {
    server.fail('/rules', 409);
    await expect(api.updateRule('e1', { value: 'X', categoryId: 'c' })).resolves.toMatchObject({ id: 'e1' });
    server.fail('/rules/e1', 422);
    await expect(api.updateRule('e1', { value: 'X', categoryId: 'c' })).rejects.toMatchObject({ status: 422 });
    await expect(api.updateRule('e2', { value: 'X', categoryId: 'c' })).resolves.toMatchObject({ id: 'e2' });
  });

  it('a held apply-rules job check stays pending at 5.9s and rejects at 6s', async () => {
    jest.useFakeTimers();
    const started = await api.startApplyRulesJob();
    server.hold(`${JOBS}/${started.jobId}`);
    let outcome = 'pending';
    const check = api.getApplyRulesJob(started.jobId).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

    await jest.advanceTimersByTimeAsync(5_900);
    const before = outcome;
    await jest.advanceTimersByTimeAsync(200);
    await check;
    expect({ before, after: outcome }).toEqual({ before: 'pending', after: 'rejected' });
  });

  it('a hold released before the limit resolves with the seeded data', async () => {
    jest.useFakeTimers();
    server.seed('/categories', [ESSENTIAL_GROCERIES]);
    const held = server.hold('/categories');
    const read = api.fetchCategories();
    await jest.advanceTimersByTimeAsync(10_000);
    held.release();
    await expect(read).resolves.toEqual([ESSENTIAL_GROCERIES]);
    await jest.advanceTimersByTimeAsync(10_000);
  });

  it('an aborted held save is still logged with its body', async () => {
    jest.useFakeTimers();
    server.hold('/categories');
    const save = api.createCategory(GYM).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(15_000);
    const error = await save;
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(server.requests()).toEqual([{ method: 'POST', path: '/categories', body: GYM }]);
  });

  it('fails only the named method; a PUT held on the same path answers normally', async () => {
    server.seed('/goals', [{ id: 'g1', target: 100 }]);
    const held = server.hold('/goals/g1');
    const save = api.saveGoal('g1', { target: 200 } as never).then(() => 'resolved', (e: unknown) => e);
    const remove = api.deleteGoal('g1').then(() => 'resolved', (e: unknown) => e);
    await drainMicrotasks();

    held.fail('DELETE', { status: 500 });

    expect(await save).toBe('resolved');
    expect(await remove).toMatchObject({ message: 'API error: 500' });
  });

  it('with two same-method calls held, only the first fails', async () => {
    const held = server.hold('/milestones');
    const first = api.setMilestones(PLAN).then(() => 'resolved', (e: unknown) => e);
    const second = api.setMilestones(PLAN).then(() => 'resolved', (e: unknown) => e);
    await drainMicrotasks();
    expect(server.sent('PUT', '/milestones')).toHaveLength(2);

    held.fail('PUT');

    expect(await first).toBeInstanceOf(TypeError);
    expect(await second).toBe('resolved');
  });

  // The hold/once behaviours the sign-out suites (sessionGuard*, saveMilestonesSignOut) lean on.
  it('a dropped reply queued while the request is held is the one it gets on release', async () => {
    const held = server.hold('/milestones');
    const save = api.setMilestones(PLAN).then(() => 'resolved', (e: unknown) => e);
    await drainMicrotasks();
    expect(server.sent('PUT', '/milestones')).toHaveLength(1);

    server.once('PUT', '/milestones', 'dropped');
    held.release();

    const outcome = await save;
    expect(outcome).toBeInstanceOf(TypeError);
    expect((outcome as Error).message).toBe('Network request failed');
  });

  it('a held create queued with a 400 + reason rejects as an ApiError carrying the reason', async () => {
    const held = server.hold('/categories');
    server.once('POST', '/categories', { status: 400, reason: CAP });
    const create = api.createCategory(GYM).then(() => 'resolved', (e: unknown) => e);
    await drainMicrotasks();
    held.release();

    const outcome = await create;
    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ status: 400, serverMessage: CAP, message: 'API error: 400' });
  });

  it('a hold is by path: it keeps both the PUT and the DELETE on that path waiting', async () => {
    const held = server.hold('/goals/g1');
    let settled = 0;
    const save = api.saveGoal('g1', { target: 200 } as never).then(() => { settled += 1; });
    const remove = api.deleteGoal('g1').then(() => { settled += 1; });
    await drainMicrotasks();
    expect(settled).toBe(0);

    held.release();
    await Promise.all([save, remove]);
    expect(settled).toBe(2);
  });

  it('holding the batch path does not hold a single charge, and holding a charge does not hold the batch', async () => {
    const batch = server.hold('/transactions');
    await expect(api.setTransactionFields('t1', { notes: 'n' } as never)).resolves.toMatchObject({ transaction_id: 't1' });
    batch.release();

    const single = server.hold('/transactions/t1');
    await expect(api.setTransactionCategories([{ id: 't1', category: 'c1' }])).resolves.toEqual({
      results: [{ id: 't1', status: 'updated' }],
    });
    single.release();
  });

  it('a held save with no queued reply resolves with the echoed plan on release, and logs its body', async () => {
    const held = server.hold('/milestones');
    const save = api.setMilestones(PLAN);
    await drainMicrotasks();
    held.release();

    await expect(save).resolves.toEqual(PLAN);
    expect(server.sent('PUT', '/milestones')).toEqual([{ method: 'PUT', path: '/milestones', body: { milestones: PLAN } }]);
  });
});

describe('WHIT-639 fake server one-shot replies (once)', () => {
  const server = installFakeServer();

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

    expect(server.sent('GET', JOB_PATH)).toHaveLength(4);
  });

  it('a queued reply beats a sticky failure, is keyed by method, and carries the server\'s reason', async () => {
    server.fail('/categories', 500);
    server.once('GET', '/categories', { body: [ESSENTIAL_GROCERIES] });
    await expect(api.fetchCategories()).resolves.toEqual([ESSENTIAL_GROCERIES]);
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

  // The preview-then-commit pattern filingRunEdges [A15] and filingRunSaveRunner.qa [A3] rely on.
  it('two held requests on one path take the queued replies in the order they were sent', async () => {
    server.once('POST', '/categories', { status: 409, reason: 'first' });
    server.once('POST', '/categories', { body: ESSENTIAL_GROCERIES });
    const held = server.hold('/categories');

    const first = api.createCategory(GYM).catch((e: unknown) => e);
    const second = api.createCategory({ name: 'Groceries', bucket: 'Living', icon: 'cart' });
    await drainMicrotasks();
    held.release();

    expect(await first).toMatchObject({ name: 'ApiError', status: 409, serverMessage: 'first' });
    await expect(second).resolves.toEqual(ESSENTIAL_GROCERIES);
  });

  // Otherwise a slow poll silently eats the answer the test meant for the next one.
  it('a held request that times out leaves the queued reply for the next call', async () => {
    jest.useFakeTimers();
    await api.startApplyRulesJob(undefined);
    server.once('GET', JOB_PATH, { body: SUCCEEDED });
    const held = server.hold(JOB_PATH);

    const timedOut = api.getApplyRulesJob('job-1').catch((e: unknown) => e);
    await drainMicrotasks();
    await jest.advanceTimersByTimeAsync(6_000);
    expect(await timedOut).toMatchObject({ name: 'AbortError' });

    held.release();
    await expect(api.getApplyRulesJob('job-1')).resolves.toEqual(SUCCEEDED);
  });

  it('a reply queued for job-1 is not used by job-2', async () => {
    await api.startApplyRulesJob(undefined);
    await api.startApplyRulesJob(undefined);
    server.once('GET', JOB_PATH, 'dropped');

    await expect(api.getApplyRulesJob('job-2')).resolves.toMatchObject({ jobId: 'job-2', status: 'running' });
    await expect(api.getApplyRulesJob('job-1')).rejects.toThrow('Network request failed');
    await expect(api.getApplyRulesJob('job-1')).resolves.toMatchObject({ jobId: 'job-1', status: 'running' });
  });

  it('a request with a query string uses the reply queued for its bare path', async () => {
    server.once('GET', '/transactions/search', { body: { transactions: [], truncated: true } });
    await expect(api.fetchTransactionsSearch('all', 'steven')).resolves.toEqual({ transactions: [], truncated: true });
    expect(server.requests()).toEqual([{ method: 'GET', path: '/transactions/search?tab=all&q=steven', body: undefined }]);
  });

  it('a dropped POST rejects with a network TypeError and is still in the request log', async () => {
    server.once('POST', JOBS, 'dropped');
    const error = await api.startApplyRulesJob(undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(server.requests()).toEqual([{ method: 'POST', path: JOBS, body: {} }]);
  });

  it('a queued error with no reason gives a withReason call a null server message', async () => {
    server.once('POST', '/categories', { status: 500 });
    await expect(api.createCategory(GYM)).rejects.toMatchObject({
      name: 'ApiError', status: 500, serverMessage: null,
    });
  });
});

describe('WHIT-652 fake server request counts (sent / sentUnder)', () => {
  const server = installFakeServer();
  const WOOLIES = { value: 'WOOLIES', categoryId: 'groceries' };

  it('sent(method, path) returns only the requests with that method and exact full path, in order', async () => {
    await api.createRule(COLES);
    await api.listRules();
    await api.createRule(WOOLIES);
    await api.fetchBudgets(14);

    expect(server.sent('GET', '/rules')).toEqual([{ method: 'GET', path: '/rules', body: undefined }]);
    expect(server.sent('POST', '/rules')).toEqual([
      { method: 'POST', path: '/rules', body: COLES },
      { method: 'POST', path: '/rules', body: WOOLIES },
    ]);
    expect(server.sent('DELETE', '/rules')).toEqual([]);
    expect(server.sent('GET', '/budgets')).toEqual([]);
    expect(server.sent('GET', '/budgets?days=14')).toHaveLength(1);
  });

  it('sentUnder(method, prefix) returns the requests with that method whose path starts with the prefix, in order', async () => {
    server.seed(JOB_PATH, { jobId: 'job-1', status: 'running' });
    await api.createRule(COLES);
    await api.getApplyRulesJob('job-1');
    await api.fetchBudgets(14);
    await api.getApplyRulesJob('job-1');

    expect(server.sentUnder('GET', '/transactions/uncategorized/apply-rules/jobs/')).toEqual([
      { method: 'GET', path: JOB_PATH, body: undefined },
      { method: 'GET', path: JOB_PATH, body: undefined },
    ]);
    expect(server.sentUnder('GET', '/budgets')).toEqual([{ method: 'GET', path: '/budgets?days=14', body: undefined }]);
    expect(server.sentUnder('POST', '/budgets')).toEqual([]);
  });

  it('sent does not treat its path as a prefix', async () => {
    server.seed('/rules', [{ id: 'e1', ...COLES }]);
    await api.updateRule('e1', COLES);
    await api.deleteRule('e1');

    expect(server.sent('PUT', '/rules')).toEqual([]);
    expect(server.sent('DELETE', '/rules')).toEqual([]);
    expect(server.sent('PUT', '/rules/e1')).toEqual([{ method: 'PUT', path: '/rules/e1', body: COLES }]);
  });

  // sentUnder('/rules') catches /rules and /rules/:id — ruleWriterRecursionGuard relies on it.
  it('sentUnder matches the prefix itself and paths below it, filtered by method', async () => {
    server.seed('/rules', [{ id: 'e1', ...COLES }]);
    await api.createRule(COLES);
    await api.updateRule('e1', COLES);
    await api.listRules();
    await api.updateRule('e1', { ...COLES, categoryId: 'dining' });

    expect(server.sentUnder('POST', '/rules')).toEqual([{ method: 'POST', path: '/rules', body: COLES }]);
    expect(server.sentUnder('PUT', '/rules').map((request) => request.body)).toEqual([
      COLES,
      { ...COLES, categoryId: 'dining' },
    ]);
    expect(server.sentUnder('GET', '/rules')).toHaveLength(1);
  });

  it('cycle 0 sends ?days=N only; cycle 1 appends &cycle=1', async () => {
    server.seed('/breakdown', BREAKDOWN);

    await api.fetchBreakdown(14);
    await api.fetchBreakdown(30, 1);

    expect(server.sentUnder('GET', '/breakdown').map((request) => request.path)).toEqual([
      '/breakdown?days=14',
      '/breakdown?days=30&cycle=1',
    ]);
  });
});

describe('WHIT-637 fake server clean-up', () => {
  it('puts the real fetch back once the fake server\'s tests are done', () => {
    expect(global.fetch).toBe(originalFetch);
  });
});
