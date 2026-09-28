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

describe('WHIT-637 fake server clean-up', () => {
  it('puts the real fetch back once the fake server\'s tests are done', () => {
    expect(global.fetch).toBe(originalFetch);
  });
});
