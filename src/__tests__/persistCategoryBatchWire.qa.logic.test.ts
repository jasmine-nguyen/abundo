// WHIT-650 QA: persistCategoryBatch through the REAL request step (src/api.ts) on the fake server —
// the wire body, a chunk refused with a status (not only a dropped connection), a failing FIRST
// chunk, the exact-100 boundary, and a missing sign-in token.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { persistCategoryBatch } from '../context';
import { installFakeServer } from './support/fakeServer';
import { resetAuth, setAuthToken } from './support/authMock';

const server = installFakeServer();

const batches = () => server.sent('PATCH', '/transactions')
  .map((r) => (r.body as { updates: { id: string; category: string }[] }).updates);
const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
const allUpdated = (ids: string[]) => ({ results: ids.map((id) => ({ id, status: 'updated' })) });

beforeEach(() => resetAuth());

describe('persistCategoryBatch on the real request step', () => {
  // [A1]
  it('sends one PATCH /transactions whose body carries every id with the chosen category', async () => {
    await persistCategoryBatch(['a', 'b'], 'coffee');

    expect(server.requests()).toEqual([{
      method: 'PATCH',
      path: '/transactions',
      body: { updates: [{ id: 'a', category: 'coffee' }, { id: 'b', category: 'coffee' }] },
    }]);
  });

  // [A2]
  it('a chunk the server refuses with a 500 counts every id in it as failed', async () => {
    server.once('PATCH', '/transactions', { status: 500 });

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect(out.failedIds).toEqual(['a', 'b']);
    expect(out.savedIds.size).toBe(0);
  });

  // [A3]
  it('a failing FIRST chunk fails only its 100 ids, in input order; the second chunk still saves', async () => {
    const ids = idsOf(150);
    server.once('PATCH', '/transactions', 'dropped');
    server.once('PATCH', '/transactions', { body: allUpdated(ids.slice(100)) });

    const out = await persistCategoryBatch(ids, 'coffee');

    expect(out.failedIds).toEqual(ids.slice(0, 100));
    expect([...out.savedIds].sort()).toEqual(ids.slice(100).sort());
  });

  // [A4]
  it('exactly 100 ids go in one request; 101 split into [100, 1]', async () => {
    await persistCategoryBatch(idsOf(100), 'coffee');
    expect(batches().map((updates) => updates.length)).toEqual([100]);

    const out = await persistCategoryBatch(idsOf(101), 'coffee');
    expect(batches().map((updates) => updates.length)).toEqual([100, 100, 1]);
    expect(out.failedIds).toEqual([]);
    expect(out.savedIds.size).toBe(101);
  });

  // [A5]
  it('with no sign-in token nothing is sent and every id comes back failed (no throw)', async () => {
    setAuthToken(undefined);

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect(server.requests()).toEqual([]);
    expect(out.failedIds).toEqual(['a', 'b']);
  });
});
