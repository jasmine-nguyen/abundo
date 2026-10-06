// WHIT-637 QA — adversarial checks on the in-memory pretend server, driven through the REAL
// src/api.ts calls: per-test isolation of every knob, query-string handling, writes landing in
// the store, the statusOnly 404 for an unknown job, and a held reply honouring the app's own
// request time limit (the abort signal), as a real fetch does.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { ApiError } from '../../apiError';
import { resetAuth } from './authMock';
import { installFakeServer, drainMicrotasks } from './fakeServer';
import { ESSENTIAL_GROCERIES } from './categories';

const originalFetch = global.fetch;

const GYM = { name: 'Gym', bucket: 'Lifestyle' as const, icon: 'dumbbell' };

beforeEach(() => resetAuth());

describe('WHIT-637 QA fake server', () => {
  const server = installFakeServer();

  afterEach(() => {
    jest.useRealTimers();
  });

  // [A1] fetch is swapped for the fake while a test runs
  it('[A1] replaces global fetch during a test', () => {
    expect(global.fetch).not.toBe(originalFetch);
  });

  // [A2] a forced failure does not leak into the next test
  it('[A2a] sets a failure on /categories', async () => {
    server.fail('/categories', 500);
    await expect(api.fetchCategories()).rejects.toThrow('API error: 500');
  });
  it('[A2b] the next test answers /categories normally again', async () => {
    await expect(api.fetchCategories()).resolves.toEqual([]);
  });

  // [A3] a hold does not leak into the next test
  it('[A3a] sets a hold on /categories and never releases it', async () => {
    jest.useFakeTimers(); // the app's own request timer stays fake, so nothing real is left running
    server.hold('/categories');
    let settled = false;
    api.fetchCategories().then(() => { settled = true; }, () => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(false);
  });
  it('[A3b] the next test is not held', async () => {
    let settled = false;
    const read = api.fetchCategories().then(() => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(true);
    await read;
  });

  // [A4] the request log starts empty in every test
  it('[A4a] logs a request', async () => {
    await api.fetchCategories();
    expect(server.requests()).toHaveLength(1);
  });
  it('[A4b] the next test starts with an empty log', () => {
    expect(server.requests()).toEqual([]);
  });

  // [A5] seed/fail/hold take a bare path; the log keeps the query string
  it('[A5] a seeded path answers a call that adds a query string, and the log keeps the query', async () => {
    const budgets = { groceries: { target: 100, spent: 40 } };
    server.seed('/budgets', budgets);
    await expect(api.fetchBudgets(14)).resolves.toEqual(budgets);
    expect(server.requests()).toEqual([{ method: 'GET', path: '/budgets?days=14', body: undefined }]);

    server.fail('/budgets', 503);
    await expect(api.fetchBudgets(14)).rejects.toThrow('API error: 503');
  });

  // [A6] the app gets its own copy — it can't change the store, and the test's object isn't shared
  it('[A6] replies are copies: changing a reply or the seeded object leaves the store alone', async () => {
    const seeded = [{ ...ESSENTIAL_GROCERIES }];
    server.seed('/categories', seeded);
    (seeded[0] as { name: string }).name = 'Changed after seeding';

    const first = await api.fetchCategories();
    (first[0] as { name: string }).name = 'Changed by the app';

    await expect(api.fetchCategories()).resolves.toEqual([ESSENTIAL_GROCERIES]);
  });

  // [A7] writes land in the store, so the next read sees them
  it('[A7] create → update → delete a category is reflected in the next read', async () => {
    server.seed('/categories', [ESSENTIAL_GROCERIES]);
    const created = await api.createCategory(GYM);
    expect(created).toMatchObject({ id: 'gym', ...GYM });
    expect((await api.fetchCategories()).map((c) => c.id)).toEqual(['groceries', 'gym']);

    await api.updateCategory('gym', { ...GYM, name: 'Gym & Pool' });
    expect((await api.fetchCategories()).find((c) => c.id === 'gym')?.name).toBe('Gym & Pool');

    await api.deleteCategory('gym');
    await expect(api.fetchCategories()).resolves.toEqual([ESSENTIAL_GROCERIES]);
  });

  it('[A7b] a created rule and a saved milestone plan are read back', async () => {
    const rule = await api.createRule({ value: 'COLES', categoryId: 'groceries' });
    expect(rule.id).toBeTruthy();
    await expect(api.listRules()).resolves.toEqual([rule]);

    const plan = [{ id: 'm1', label: 'Half way', amount: 250000 }] as unknown as Parameters<typeof api.setMilestones>[0];
    await api.setMilestones(plan);
    await expect(api.fetchMilestones()).resolves.toEqual(plan);
  });

  // [A8] a started job can be polled; an unknown job is a 404 carrying the status (statusOnly)
  it('[A8] a started apply-rules job is readable by its id; an unknown id rejects 404', async () => {
    const started = await api.startApplyRulesJob();
    expect(started).toMatchObject({ status: 'running' });
    await expect(api.getApplyRulesJob(started.jobId)).resolves.toMatchObject({ jobId: started.jobId, status: 'running' });

    const missing = await api.getApplyRulesJob('no-such-job').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ApiError);
    expect(missing).toMatchObject({ status: 404, message: 'API error: 404' });
  });

  // [A9] a fail() on one path does not touch its neighbours
  it('[A9] a failure on one path leaves the paths above and beside it working', async () => {
    server.fail('/rules', 409);
    await expect(api.updateRule('e1', { value: 'X', categoryId: 'c' })).resolves.toMatchObject({ id: 'e1' });
    server.fail('/rules/e1', 422);
    await expect(api.updateRule('e1', { value: 'X', categoryId: 'c' })).rejects.toMatchObject({ status: 422 });
    await expect(api.updateRule('e2', { value: 'X', categoryId: 'c' })).resolves.toMatchObject({ id: 'e2' });
  });

  // [A10] a held reply still obeys the app's own time limit: past it, the call fails like a real
  // aborted request instead of waiting forever for release().
  it('[A10] a held read rejects once the request time limit passes (the abort signal is honoured)', async () => {
    jest.useFakeTimers();
    const held = server.hold('/categories');
    let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    const read = api.fetchCategories().then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });

    await jest.advanceTimersByTimeAsync(15_000);
    await drainMicrotasks();
    const seen = outcome;
    held.release();
    await read;
    expect(seen).toBe('rejected');
  });
});

describe('WHIT-637 QA fake server clean-up', () => {
  // [A1] …and put back after every test
  it('[A1] the real fetch is back after the fake server\'s tests', () => {
    expect(global.fetch).toBe(originalFetch);
  });
});
