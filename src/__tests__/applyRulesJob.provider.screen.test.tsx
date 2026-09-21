// WHIT-560 — the async "apply my rules over all history" background job, provider side.
//
// The provider POSTs to start a job, then polls its status on a SELF-SCHEDULING loop until terminal.
// The properties that carry real risk (and are exercised here):
//   - success reconciles the caches via invalidation (the GET returns counts, not id lists, so there
//     is no per-row patch), and the job status transitions running → succeeded/failed.
//   - a server `status:"failed"` or a 404 (expired id) is terminal; a THROWN fetch (offline) is NOT
//     a failure — it is swallowed and retried, and only gives up after the consecutive-error cap.
//   - a job already terminal on the first poll (completed before the first GET) goes straight to done.
//   - a running job holds the "one heavy run at a time" lock — the sync sweep can't start on top.
//   - sign-out mid-run stops polling; no status read fires into the next session.
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
import { ApiError } from '../apiError';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

const POLL = 2500; // APPLY_RULES_JOB_POLL_DELAY_MS

function mount() {
  return renderHook(() => useAppContext(), { wrapper }).result;
}

/** Advance one poll cycle and let the async GET (and the state it sets) settle. */
async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL); });
  }
}

/** A promise the test resolves itself, so a GET can be left in flight while the sheet changes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); jest.useFakeTimers(); mockStatus = 'authed'; });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

it('starts a job, shows it running, and polls to success — refreshing caches once', async () => {
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  mockApi.startApplyRulesJob.mockResolvedValue(job({ status: 'running' }));
  mockApi.getApplyRulesJob
    .mockResolvedValueOnce(job({ status: 'running', matched: 900, filed: 300 }))
    .mockResolvedValueOnce(job({ status: 'succeeded', matched: 900, filed: 900, remaining: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  expect(r.current.applyRulesJob?.status).toBe('running');

  await tick();
  expect(r.current.applyRulesJob).toMatchObject({ status: 'running', matched: 900, filed: 300 });
  const before = invalidate.mock.calls.length;

  await tick();
  expect(r.current.applyRulesJob?.status).toBe('succeeded');
  // Success reconciles the caches (the count/badge/feed this feature is about).
  const keys = invalidate.mock.calls.slice(before).map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toEqual(expect.arrayContaining(['uncategorizedCount', 'categories', 'uncategorizedMerchants']));
});

it('treats a server status:"failed" as terminal and surfaces the error', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValueOnce(job({ status: 'failed', error: 'boom' }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick();

  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'boom' });
});

it('treats a 404 (expired id) as a terminal failure', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockRejectedValueOnce(new ApiError(404, null));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick();

  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'expired' });
});

it('tolerates a transient network throw and keeps polling', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob
    .mockRejectedValueOnce(new Error('offline'))                       // dropped poll — NOT a failure
    .mockResolvedValueOnce(job({ status: 'succeeded', matched: 5, filed: 5 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });

  await tick();
  expect(r.current.applyRulesJob?.status).toBe('running'); // the blip did not flip it to failed
  await tick();
  expect(r.current.applyRulesJob?.status).toBe('succeeded');
});

it('gives up after too many consecutive network throws', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockRejectedValue(new Error('offline'));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(5); // APPLY_RULES_JOB_MAX_NET_ERRORS

  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });
});

it('goes straight to done when the first poll is already succeeded (finished before the first GET)', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValueOnce(job({ status: 'succeeded', matched: 0, filed: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick();

  expect(r.current.applyRulesJob).toMatchObject({ status: 'succeeded', matched: 0, filed: 0 });
});

it('blocks the sync sweep while a job is running (one heavy run at a time)', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, filed: 100 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  expect(r.current.applyRulesJob?.status).toBe('running');

  // A second start is turned away; the sync sweep bails without touching the api.
  let second: unknown;
  await act(async () => { second = await r.current.startApplyRulesSweep(); });
  expect(second).toEqual({ ok: false, clash: null });
  expect(mockApi.startApplyRulesJob).toHaveBeenCalledTimes(1);
  let sync: unknown;
  await act(async () => { sync = await r.current.applyRulesToHistory(); });
  expect(sync).toBeNull();
  expect(mockApi.applyRulesToUncategorized).not.toHaveBeenCalled();
});

it('does not leave two poll chains after a dismiss + reopen during an in-flight GET', async () => {
  // Fail-on-revert for the poll-generation guard: a GET left in flight by a dismiss must NOT re-arm
  // the timer when it resolves, or the reopen's fresh timer plus the stale one give two live chains.
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  const first = deferred<ApplyRulesJob>();
  mockApi.getApplyRulesJob
    .mockReturnValueOnce(first.promise) // the first GET hangs, in flight across the dismiss
    .mockResolvedValue(job({ status: 'running', matched: 900, filed: 100 }));

  const r = mount();
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await act(async () => { jest.advanceTimersByTime(POLL); });   // fire poll 1 — its GET is now pending
  expect(mockApi.getApplyRulesJob).toHaveBeenCalledTimes(1);

  await act(async () => { r.current.setSheet(null); });          // dismiss mid-GET (bumps the generation)
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); }); // reopen (arms a fresh timer)
  await act(async () => { first.resolve(job({ status: 'running', matched: 900, filed: 100 })); await Promise.resolve(); });

  // Exactly ONE chain is live now: one delay ⇒ exactly one more GET, not two.
  const before = mockApi.getApplyRulesJob.mock.calls.length;
  await act(async () => { await jest.advanceTimersByTimeAsync(POLL); });
  expect(mockApi.getApplyRulesJob.mock.calls.length).toBe(before + 1);
});

it('retry re-runs the SAME variant that failed, not a plain sweep', async () => {
  // A file-this-shop job fails; "Try again" must restart THAT shop's job — with its rule —
  // not a whole-rules sweep. (Finding 1: applyRulesJob is global, so the failed job can be shown
  // and retried from the plain sheet, which would otherwise call startApplyRulesSweep.)
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValueOnce(job({ status: 'failed', error: 'boom' }));

  const r = mount();
  const group = { rulePattern: 'WOOLWORTHS' } as Parameters<typeof r.current.startFileByShopJob>[0];
  await act(async () => { await r.current.startFileByShopJob(group, 'groceries'); });
  await tick();
  expect(r.current.applyRulesJob?.status).toBe('failed');

  await act(async () => { await r.current.retryApplyRulesJob(); });
  expect(mockApi.startApplyRulesJob).toHaveBeenCalledTimes(2);
  // Both starts carry the SHOP's rule — the retry did not fall back to a rule-less sweep.
  expect(mockApi.startApplyRulesJob).toHaveBeenNthCalledWith(2, { value: 'WOOLWORTHS', categoryId: 'groceries' });
});

it('stops polling on sign-out and never reads status into the next session', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, filed: 100 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick();
  const callsBefore = mockApi.getApplyRulesJob.mock.calls.length;

  await act(async () => { mockSetStatus('anon'); });
  expect(r.current.applyRulesJob).toBeNull();

  await tick(3);
  expect(mockApi.getApplyRulesJob.mock.calls.length).toBe(callsBefore); // no zombie poll
});
