// WHIT-560 — provider poll-loop GAPS not covered by applyRulesJob.provider.screen.test.tsx.
//
// Adversarial half: the self-scheduling loop must not overlap even when a GET outlasts the delay;
// unmount / a Face-ID lock (getStatus !== 'authed', distinct from sign-out) must stop polling and
// drop the job; and the terminal reconcile differs by variant — the "add rule" job prepends the
// minted rule with its NEW badge (skipRules) while "file this shop" refreshes rules normally.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext, APPLY_RULES_MAX_WRITES } from '../context';
import type { ApplyRulesJob, FilingTarget, FilingWhen } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';
import type { CreatedRule, UncategorizedMerchantGroup } from '../api';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper as wrapper } from './support/renderWithApp';
const SWEEP: FilingTarget = { kind: 'sweep' };
const BIG_RUN: FilingWhen = { matched: APPLY_RULES_MAX_WRITES + 1 }; // over the cap → a background job

const server = installFakeServer();
const JOBS = '/transactions/uncategorized/apply-rules/jobs';
const jobPath = (jobId: string) => `${JOBS}/${jobId}`;
// How many times the app has checked on a job (any job) so far.
const polls = () => server.sentUnder('GET', `${JOBS}/`).length;

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'job-1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
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

beforeEach(() => { queryClient.clear(); jest.useFakeTimers(); resetAuth(); });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

// [G1] no overlap: one GET per delay even when a GET outlasts the delay (a held reply that never
// arrives during the window). The loop arms the next poll ONLY after the current settles, so
// advancing several delays while a GET is in flight must NOT fan out extra GETs.
it('[G1] fires exactly one GET per delay even when a GET outlasts the delay', async () => {
  const r = mount().result;
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  const held = server.hold(jobPath('job-1'));

  await tick();                                             // first poll fires → GET pending
  expect(polls()).toBe(1);

  await tick(3);                                            // GET still pending — no fan-out
  expect(polls()).toBe(1);

  server.seed(jobPath('job-1'), job({ status: 'running', matched: 10, filed: 1 }));
  await act(async () => { held.release(); });
  await tick();                                             // resolved → next poll armed → fires
  expect(polls()).toBe(2);
});

// [G2] unmount mid-poll clears the timer — no GET fires after the provider unmounts.
it('[G2] clears the poll timer on unmount (no zombie GET)', async () => {
  const h = mount();
  await act(async () => { await h.result.current.fileCharges(SWEEP, BIG_RUN); });
  server.seed(jobPath('job-1'), job({ status: 'running', matched: 900, filed: 100 }));
  await tick();
  const before = polls();

  h.unmount();
  await tick(3);
  expect(polls()).toBe(before);
});

// [G3] a Face-ID lock (getStatus() !== 'authed', NOT sign-out) stops the poll and drops the job.
// Distinct from the sign-out test: the session epoch is untouched, so a fresh sweep can start after
// unlock (the lock was released).
it('[G3] a Face-ID lock stops polling, drops the job, and releases the lock', async () => {
  const r = mount().result;
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  server.seed(jobPath('job-1'), job({ status: 'running', matched: 900, filed: 100 }));
  await tick();
  const before = polls();

  await act(async () => { setAuthStatus('locked'); });
  expect(r.current.applyRulesJob).toBeNull();              // job view dropped

  await tick(3);
  expect(polls()).toBe(before);                            // poll stopped

  // The lock was released (not just the timer) — a new sweep is accepted, not turned away.
  setAuthStatusQuietly('authed');
  let started: unknown;
  await act(async () => { started = await r.current.fileCharges(SWEEP, BIG_RUN); });
  expect(started).toEqual({ status: 'background' });
});

// [G5] a Face-ID lock DURING the start POST must discard the start — not resurrect the job and leave
// the lock released. A lock flips applyRulesJobActive false (and drops the job) but does NOT bump the
// session epoch, so the epoch-only guard would let the resolved POST arm a poll loop while the "one
// heavy run at a time" latch reads false → a sync sweep could run concurrently. Fail-on-revert for
// the `!applyRulesJobActive.current` half of beginApplyRulesJob's post-await guard.
it('[G5] a lock while the start POST is in flight discards the start and keeps the lock consistent', async () => {
  const held = server.hold(JOBS);

  const r = mount().result;
  let started: Promise<unknown>;
  await act(async () => { started = r.current.fileCharges(SWEEP, BIG_RUN); });   // POST now pending
  await act(async () => { setAuthStatus('locked'); });                      // lock clears active + job
  await act(async () => { held.release(); await started; });

  expect(r.current.applyRulesJob).toBeNull();               // the cleared job is NOT resurrected
  await tick(3);
  expect(polls()).toBe(0);                                  // no poll loop was armed

  // The lock was left consistent — after unlock a fresh sweep is accepted (latch not stuck true).
  setAuthStatusQuietly('authed');
  let again: unknown;
  await act(async () => { again = await r.current.fileCharges(SWEEP, BIG_RUN); });
  expect(again).toEqual({ status: 'background' });
});

// [G4] terminal reconcile — the "add rule" variant prepends the minted rule with its NEW badge and
// SKIPS the rules refetch; every other variant (here "file this shop") refreshes rules normally and
// does NOT prepend. Guards the createdRule/skipRules asymmetry in finishApplyRulesJob.
it('[G4] add-rule success prepends the minted rule (NEW badge) and skips the rules refetch', async () => {
  queryClient.setQueryData(['rules'], []); // seed so patchRules has a cache to prepend into
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  const r = mount().result;
  await act(async () => { await r.current.fileCharges({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: false }, BIG_RUN); });
  server.seed(jobPath('job-1'), job({ status: 'succeeded', matched: 5, filed: 5, createdRule: minted }));
  const before = invalidate.mock.calls.length;
  await tick();

  const rules = queryClient.getQueryData(['rules']) as Array<{ id: string; isNew: boolean }>;
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ id: 'r-new', isNew: true });
  const keys = invalidatedKeys(invalidate).slice(before);
  expect(keys).not.toContain('rules'); // skipRules — a refetch would reset the NEW badge
});

it('[G4] file-this-shop success does NOT prepend and DOES refresh the rules list', async () => {
  queryClient.setQueryData(['rules'], []);
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  const r = mount().result;
  const grp = { merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 5, samples: [], firstDate: '2026-01-01', lastDate: '2026-02-01', alsoCatches: [] } as unknown as UncategorizedMerchantGroup;
  await act(async () => { await r.current.fileCharges({ kind: 'shop', group: grp, categoryId: 'groceries' }, BIG_RUN); });
  server.seed(jobPath('job-1'), job({ status: 'succeeded', matched: 5, filed: 5, createdRule: minted }));
  const before = invalidate.mock.calls.length;
  await tick();

  expect(queryClient.getQueryData(['rules'])).toEqual([]); // no optimistic prepend
  const keys = invalidatedKeys(invalidate).slice(before);
  expect(keys).toContain('rules'); // refreshed normally
});
