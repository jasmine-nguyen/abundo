// WHIT-292 — unit tests for the extracted persistCategoryBatch helper (context.tsx).
// The provider suites prove the two writers still behave; this pins the shared helper's
// own chunk/reconcile math directly: empty-input no-call, the 100-row chunk boundary,
// reconcile BY id (not array position), and every failed-id path (rejected chunk,
// malformed response, not_found status).
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { persistCategoryBatch } from '../context';
import { installFakeServer } from './support/fakeServer';

const server = installFakeServer();

// Server "everything updated" reply for a given chunk of ids.
const allUpdated = (ids: string[]) => ({ results: ids.map((id) => ({ id, status: 'updated' })) });
// The `updates` of every batch save the app sent, in order.
const batches = () => server.requests()
  .filter((r) => r.method === 'PATCH' && r.path === '/transactions')
  .map((r) => (r.body as { updates: { id: string; category: string }[] }).updates);

describe('persistCategoryBatch', () => {
  it('makes no API call on empty ids and returns empty sets', async () => {
    const out = await persistCategoryBatch([], 'coffee');
    expect(batches()).toHaveLength(0);
    expect(out.failedIds).toEqual([]);
    expect(out.savedIds.size).toBe(0);
  });

  it('splits >CATEGORY_BATCH_LIMIT ids into [100, 50] chunks and marks all saved', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);

    const out = await persistCategoryBatch(ids, 'coffee');

    expect(batches()).toHaveLength(2);
    expect(batches()[0]).toHaveLength(100);
    expect(batches()[1]).toHaveLength(50);
    expect(out.failedIds).toEqual([]);
    expect(out.savedIds.size).toBe(150);
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

  it('treats a malformed response (missing results) as all-failed via the ?? [] guard', async () => {
    server.once('PATCH', '/transactions', { body: {} });

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect(out.savedIds.size).toBe(0);
    expect(out.failedIds).toEqual(['a', 'b']);
  });

  it('treats a not_found status as failed (only "updated" counts as saved)', async () => {
    server.once('PATCH', '/transactions', {
      body: { results: [{ id: 'a', status: 'updated' }, { id: 'b', status: 'not_found' }] },
    });

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect([...out.savedIds]).toEqual(['a']);
    expect(out.failedIds).toEqual(['b']);
  });
});
