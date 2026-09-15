// WHIT-560 — provider poll-loop GAPS not covered by applyRulesJob.provider.screen.test.tsx.
//
// Adversarial half: the self-scheduling loop must not overlap even when a GET outlasts the delay;
// unmount / a Face-ID lock (getStatus !== 'authed', distinct from sign-out) must stop polling and
// drop the job; and the terminal reconcile differs by variant — the "add rule" job prepends the
// minted rule with its NEW badge (skipRules) while "file this shop" refreshes rules normally.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { ApplyRulesJob } from '../context';
import { queryClient } from '../queryClient';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (status: typeof mockStatus) => {
  mockStatus = status;
  mockListeners.forEach((listener) => listener());
};
jest.mock('../api');
jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
import * as api from '../api';
import type { CreatedRule } from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

const minted: CreatedRule = { id: 'r-new', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' };

const POLL = 2500; // APPLY_RULES_JOB_POLL_DELAY_MS

function mount() {
  return renderHook(() => useAppContext(), { wrapper });
}
async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL); });
  }
}

/** A promise the test resolves itself, so the start POST can be left in flight while the app locks. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); jest.useFakeTimers(); mockStatus = 'authed'; });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

// [G1] no overlap: one GET per delay even when a GET outlasts the delay (deferred that never
// resolves during the window). The loop arms the next poll ONLY after the current settles, so
// advancing several delays while a GET is in flight must NOT fan out extra GETs.
it('[G1] fires exactly one GET per delay even when a GET outlasts the delay', async () => {
  let resolveGet: (j: ApplyRulesJob) => void = () => {};
  mockApi.startApplyRulesJob.mockResolvedValue(job({ status: 'running' }));
  mockApi.getApplyRulesJob.mockImplementation(() => new Promise<ApplyRulesJob>((res) => { resolveGet = res; }));

  const r = mount().result;
  await act(async () => { await r.current.startApplyRulesSweep(); });

  await tick();                                             // first poll fires → GET pending
  expect(mockApi.getApplyRulesJob).toHaveBeenCalledTimes(1);

  await tick(3);                                            // GET still pending — no fan-out
  expect(mockApi.getApplyRulesJob).toHaveBeenCalledTimes(1);

  await act(async () => { resolveGet(job({ status: 'running', matched: 10, filed: 1 })); });
  await tick();                                             // resolved → next poll armed → fires
  expect(mockApi.getApplyRulesJob).toHaveBeenCalledTimes(2);
});

// [G2] unmount mid-poll clears the timer — no GET fires after the provider unmounts.
it('[G2] clears the poll timer on unmount (no zombie GET)', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, filed: 100 }));

  const h = mount();
  await act(async () => { await h.result.current.startApplyRulesSweep(); });
  await tick();
  const before = mockApi.getApplyRulesJob.mock.calls.length;

  h.unmount();
  await tick(3);
  expect(mockApi.getApplyRulesJob.mock.calls.length).toBe(before);
});

// [G3] a Face-ID lock (getStatus() !== 'authed', NOT sign-out) stops the poll and drops the job.
// Distinct from the sign-out test: the session epoch is untouched, so a fresh sweep can start after
// unlock (the lock was released).
it('[G3] a Face-ID lock stops polling, drops the job, and releases the lock', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, filed: 100 }));

  const r = mount().result;
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick();
  const before = mockApi.getApplyRulesJob.mock.calls.length;

  await act(async () => { mockSetStatus('locked'); });
  expect(r.current.applyRulesJob).toBeNull();              // job view dropped

  await tick(3);
  expect(mockApi.getApplyRulesJob.mock.calls.length).toBe(before); // poll stopped

  // The lock was released (not just the timer) — a new sweep is accepted, not turned away.
  mockStatus = 'authed';
  let started: unknown;
  await act(async () => { started = await r.current.startApplyRulesSweep(); });
  expect(started).toEqual({ ok: true });
});

// [G5] a Face-ID lock DURING the start POST must discard the start — not resurrect the job and leave
// the lock released. A lock flips applyRulesJobActive false (and drops the job) but does NOT bump the
// session epoch, so the epoch-only guard would let the resolved POST arm a poll loop while the "one
// heavy run at a time" latch reads false → a sync sweep could run concurrently. Fail-on-revert for
// the `!applyRulesJobActive.current` half of beginApplyRulesJob's post-await guard.
it('[G5] a lock while the start POST is in flight discards the start and keeps the lock consistent', async () => {
  const start = deferred<ApplyRulesJob>();
  mockApi.startApplyRulesJob.mockReturnValueOnce(start.promise);
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, filed: 100 }));

  const r = mount().result;
  let started: Promise<unknown>;
  await act(async () => { started = r.current.startApplyRulesSweep(); });   // POST now pending
  await act(async () => { mockSetStatus('locked'); });                      // lock clears active + job
  await act(async () => { start.resolve(job({ status: 'running' })); await started; });

  expect(r.current.applyRulesJob).toBeNull();               // the cleared job is NOT resurrected
  await tick(3);
  expect(mockApi.getApplyRulesJob).not.toHaveBeenCalled();  // no poll loop was armed

  // The lock was left consistent — after unlock a fresh sweep is accepted (latch not stuck true).
  mockStatus = 'authed';
  mockApi.startApplyRulesJob.mockResolvedValueOnce(job({ status: 'running' }));
  let again: unknown;
  await act(async () => { again = await r.current.startApplyRulesSweep(); });
  expect(again).toEqual({ ok: true });
});

// [G4] terminal reconcile — the "add rule" variant prepends the minted rule with its NEW badge and
// SKIPS the rules refetch; every other variant (here "file this shop") refreshes rules normally and
// does NOT prepend. Guards the createdRule/skipRules asymmetry in finishApplyRulesJob.
it('[G4] add-rule success prepends the minted rule (NEW badge) and skips the rules refetch', async () => {
  queryClient.setQueryData(['rules'], []); // seed so patchRules has a cache to prepend into
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  mockApi.startApplyRulesJob.mockResolvedValue(job({ status: 'running' }));
  mockApi.getApplyRulesJob.mockResolvedValueOnce(job({ status: 'succeeded', matched: 5, filed: 5, createdRule: minted }));

  const r = mount().result;
  await act(async () => { await r.current.startNewRuleJob('COLES', 'groceries', false); });
  const before = invalidate.mock.calls.length;
  await tick();

  const rules = queryClient.getQueryData(['rules']) as Array<{ id: string; isNew: boolean }>;
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ id: 'r-new', isNew: true });
  const keys = invalidate.mock.calls.slice(before).map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).not.toContain('rules'); // skipRules — a refetch would reset the NEW badge
});

it('[G4] file-this-shop success does NOT prepend and DOES refresh the rules list', async () => {
  queryClient.setQueryData(['rules'], []);
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  mockApi.startApplyRulesJob.mockResolvedValue(job({ status: 'running' }));
  mockApi.getApplyRulesJob.mockResolvedValueOnce(job({ status: 'succeeded', matched: 5, filed: 5, createdRule: minted }));

  const r = mount().result;
  const grp = { merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 5, samples: [], firstDate: '2026-01-01', lastDate: '2026-02-01', alsoCatches: [] } as unknown as Parameters<typeof r.current.startFileByShopJob>[0];
  await act(async () => { await r.current.startFileByShopJob(grp, 'groceries'); });
  const before = invalidate.mock.calls.length;
  await tick();

  expect(queryClient.getQueryData(['rules'])).toEqual([]); // no optimistic prepend
  const keys = invalidate.mock.calls.slice(before).map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toContain('rules'); // refreshed normally
});
