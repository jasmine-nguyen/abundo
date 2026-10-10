// WHIT-292 — unit tests for the extracted persistCategoryBatch helper (context.tsx).
// The provider suites prove the two writers still behave; this pins the shared helper's
// own chunk/reconcile math directly through the real request step: the wire body, the
// 100-row chunk boundary, reconcile BY id (not array position), and every failed-id path
// (rejected chunk, not_found status, no sign-in token).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { persistCategoryBatch } from '../context';
import { installFakeServer } from './support/fakeServer';
import { resetAuth, setAuthToken } from './support/authMock';

const server = installFakeServer();

beforeEach(() => resetAuth());

// Server "everything updated" reply for a given chunk of ids.
const allUpdated = (ids: string[]) => ({ results: ids.map((id) => ({ id, status: 'updated' })) });
// The `updates` of every batch save the app sent, in order.
const batches = () => server.sent('PATCH', '/transactions')
  .map((r) => (r.body as { updates: { id: string; category: string }[] }).updates);

describe('persistCategoryBatch', () => {

  it.each([
    [100, [100]],
    [101, [100, 1]],
    [150, [100, 50]],
  ])('splits %i ids into CATEGORY_BATCH_LIMIT chunks %j and marks all saved', async (count, chunks) => {
    const ids = Array.from({ length: count }, (_, i) => `t${i}`);

    const out = await persistCategoryBatch(ids, 'coffee');

    expect(batches().map((updates) => updates.length)).toEqual(chunks);
    expect(out.failedIds).toEqual([]);
    expect(out.savedIds.size).toBe(count);
  });

  it('reconciles saved ids BY id, not array position', async () => {
    // Server reports ids out of order and omits one; only reported-updated ids are saved.
    server.once('PATCH', '/transactions', {
      body: { results: [{ id: 'b', status: 'updated' }, { id: 'a', status: 'updated' }] },
    });

    const out = await persistCategoryBatch(['a', 'b', 'c'], 'coffee');

    expect([...out.savedIds].sort()).toEqual(['a', 'b']);
    expect(out.failedIds).toEqual(['c']); // never returned updated -> failed
  });

  it('treats a rejected chunk as all-failed, preserving input order', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);
    server.once('PATCH', '/transactions', { body: allUpdated(ids.slice(0, 100)) }); // first 100 ok
    server.once('PATCH', '/transactions', 'dropped');                                // last 50 rejects

    const out = await persistCategoryBatch(ids, 'coffee');

    expect(out.failedIds).toEqual(ids.slice(100)); // exactly the rejected chunk's ids, in order
    expect(out.savedIds.size).toBe(100);
  });

  it('treats a not_found status as failed (only "updated" counts as saved)', async () => {
    server.once('PATCH', '/transactions', {
      body: { results: [{ id: 'a', status: 'updated' }, { id: 'b', status: 'not_found' }] },
    });

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect([...out.savedIds]).toEqual(['a']);
    expect(out.failedIds).toEqual(['b']);
  });

  it('sends one PATCH /transactions whose body carries every id with the chosen category', async () => {
    await persistCategoryBatch(['a', 'b'], 'coffee');

    expect(server.requests()).toEqual([{
      method: 'PATCH',
      path: '/transactions',
      body: { updates: [{ id: 'a', category: 'coffee' }, { id: 'b', category: 'coffee' }] },
    }]);
  });

  it('with no sign-in token nothing is sent and every id comes back failed (no throw)', async () => {
    setAuthToken(undefined);

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect(server.requests()).toEqual([]);
    expect(out.failedIds).toEqual(['a', 'b']);
  });
});
