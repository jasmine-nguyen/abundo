// WHIT-292 — unit tests for the extracted persistCategoryBatch helper (context.tsx).
// The provider suites prove the two writers still behave; this pins the shared helper's
// own chunk/reconcile math directly: empty-input no-call, the 100-row chunk boundary,
// reconcile BY id (not array position), and every failed-id path (rejected chunk,
// malformed response, not_found status).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../api');
import * as api from '../api';
import { persistCategoryBatch } from '../context';

const mockApi = api as jest.Mocked<typeof api>;

// Server "everything updated" reply for a given chunk of updates.
const allUpdated = (updates: { id: string; category: string }[]) =>
  ({ results: updates.map((u) => ({ id: u.id, status: 'updated' as const })) });

beforeEach(() => {
  mockApi.setTransactionCategories.mockReset();
});

describe('persistCategoryBatch', () => {
  it('makes no API call on empty ids and returns empty sets', async () => {
    const out = await persistCategoryBatch([], 'coffee');
    expect(mockApi.setTransactionCategories).not.toHaveBeenCalled();
    expect(out.failedIds).toEqual([]);
    expect(out.savedIds.size).toBe(0);
  });

  it('splits >CATEGORY_BATCH_LIMIT ids into [100, 50] chunks and marks all saved', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);
    mockApi.setTransactionCategories.mockImplementation(async (updates) => allUpdated(updates));

    const out = await persistCategoryBatch(ids, 'coffee');

    expect(mockApi.setTransactionCategories).toHaveBeenCalledTimes(2);
    expect(mockApi.setTransactionCategories.mock.calls[0][0]).toHaveLength(100);
    expect(mockApi.setTransactionCategories.mock.calls[1][0]).toHaveLength(50);
    expect(out.failedIds).toEqual([]);
    expect(out.savedIds.size).toBe(150);
  });

  it('reconciles saved ids BY id, not array position', async () => {
    // Server reports ids out of order and omits one; only reported-updated ids are saved.
    mockApi.setTransactionCategories.mockResolvedValue({
      results: [{ id: 'b', status: 'updated' }, { id: 'a', status: 'updated' }],
    });

    const out = await persistCategoryBatch(['a', 'b', 'c'], 'coffee');

    expect([...out.savedIds].sort()).toEqual(['a', 'b']);
    expect(out.failedIds).toEqual(['c']); // never returned updated -> failed
  });

  it('treats a rejected chunk as all-failed, preserving input order', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `t${i}`);
    mockApi.setTransactionCategories
      .mockImplementationOnce(async (updates) => allUpdated(updates)) // first 100 ok
      .mockRejectedValueOnce(new Error('network'));                    // last 50 rejects

    const out = await persistCategoryBatch(ids, 'coffee');

    expect(out.failedIds).toEqual(ids.slice(100)); // exactly the rejected chunk's ids, in order
    expect(out.savedIds.size).toBe(100);
  });

  it('treats a malformed response (missing results) as all-failed via the ?? [] guard', async () => {
    mockApi.setTransactionCategories.mockResolvedValue({} as never);

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect(out.savedIds.size).toBe(0);
    expect(out.failedIds).toEqual(['a', 'b']);
  });

  it('treats a not_found status as failed (only "updated" counts as saved)', async () => {
    mockApi.setTransactionCategories.mockResolvedValue({
      results: [{ id: 'a', status: 'updated' }, { id: 'b', status: 'not_found' }],
    });

    const out = await persistCategoryBatch(['a', 'b'], 'coffee');

    expect([...out.savedIds]).toEqual(['a']);
    expect(out.failedIds).toEqual(['b']);
  });
});
