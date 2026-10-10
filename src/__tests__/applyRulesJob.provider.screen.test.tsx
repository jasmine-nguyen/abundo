// WHIT-560 — the async "apply my rules over all history" background job, provider side.
//
// The provider POSTs to start a job, then polls its status on a SELF-SCHEDULING loop until terminal.
// The properties that carry real risk (and are exercised here):
//   - success reconciles the caches via invalidation (the GET returns counts, not id lists, so there
//     is no per-row patch), and the job status transitions running → succeeded/failed.
//   - a server `status:"failed"` or a 404 (expired id) is terminal; a THROWN fetch (offline) is NOT
//     a failure — it is swallowed and retried, and only gives up after the consecutive-error cap.
//   - a running job holds the "one heavy run at a time" lock — the sync sweep can't start on top.
//   - sign-out mid-run stops polling; no status read fires into the next session; a Face-ID lock
//     stops it too and releases the lock.
//   - a job stuck at `running` raises a non-destructive stall hint (WHIT-565).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext, APPLY_RULES_MAX_WRITES } from '../context';
import type { ApplyRulesJob, FilingTarget, FilingWhen } from '../context';
import type { CreatedRule, UncategorizedMerchantGroup } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper as wrapper } from './support/renderWithApp';
const SWEEP: FilingTarget = { kind: 'sweep' };
const BIG_RUN: FilingWhen = { matched: APPLY_RULES_MAX_WRITES + 1 }; // over the cap → a background job

const server = installFakeServer();
const JOBS = '/transactions/uncategorized/apply-rules/jobs';
const JOB_PATH = `${JOBS}/job-1`;

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'job-1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
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

beforeEach(() => { queryClient.clear(); jest.useFakeTimers(); resetAuth(); });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

it('starts a job, shows it running, and polls to success — refreshing caches once', async () => {
  const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
  server.once('GET', JOB_PATH, { body: job({ status: 'running', matched: 900, filed: 300 }) });
  server.once('GET', JOB_PATH, { body: job({ status: 'succeeded', matched: 900, filed: 900, remaining: 0 }) });

  const r = mount();
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  expect(r.current.applyRulesJob?.status).toBe('running');

  await tick();
  expect(r.current.applyRulesJob).toMatchObject({ status: 'running', matched: 900, filed: 300 });
  const before = invalidate.mock.calls.length;

  await tick();
  expect(r.current.applyRulesJob?.status).toBe('succeeded');
  // Success reconciles the caches (the count/badge/feed this feature is about).
  const keys = invalidatedKeys(invalidate).slice(before);
  expect(keys).toEqual(expect.arrayContaining(['uncategorizedCount', 'categories', 'uncategorizedMerchants']));
});

it.each([
  ['treats a server status:"failed" as terminal and surfaces the error', { body: job({ status: 'failed', error: 'boom' }) }, 'boom'],
  ['treats a 404 (expired id) as a terminal failure', { status: 404 }, 'expired'],
])('%s', async (_name, reply, error) => {
  server.once('GET', JOB_PATH, reply);

  const r = mount();
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  await tick();

  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error });
});

it('tolerates a transient network throw and keeps polling', async () => {
  server.once('GET', JOB_PATH, 'dropped');                              // dropped poll — NOT a failure
  server.once('GET', JOB_PATH, { body: job({ status: 'succeeded', matched: 5, filed: 5 }) });

  const r = mount();
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });

  await tick();
  expect(r.current.applyRulesJob?.status).toBe('running'); // the blip did not flip it to failed
  await tick();
  expect(r.current.applyRulesJob?.status).toBe('succeeded');
});

it('gives up after too many consecutive network throws', async () => {
  for (let i = 0; i < 5; i++) server.once('GET', JOB_PATH, 'dropped');

  const r = mount();
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  await tick(5); // APPLY_RULES_JOB_MAX_NET_ERRORS

  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });
});

it('blocks the sync sweep while a job is running (one heavy run at a time)', async () => {
  const r = mount();
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  server.seed(JOB_PATH, job({ status: 'running', matched: 900, filed: 100 }));
  expect(r.current.applyRulesJob?.status).toBe('running');

  // A second start is turned away; the sync sweep bails without touching the api.
  let second: unknown;
  await act(async () => { second = await r.current.fileCharges(SWEEP, BIG_RUN); });
  expect(second).toEqual({ status: 'failed', background: true });
  expect(server.sent('POST', JOBS).length).toBe(1);
  let sync: unknown;
  await act(async () => { sync = await r.current.fileCharges(SWEEP, { now: true }); });
  expect(sync).toEqual({ status: 'failed', background: false });
  expect(server.sent('POST', '/transactions/uncategorized/apply-rules').length).toBe(0);
});

it('does not leave two poll chains after a dismiss + reopen during an in-flight GET', async () => {
  // Fail-on-revert for the poll-generation guard: a GET left in flight by a dismiss must NOT re-arm
  // the timer when it resolves, or the reopen's fresh timer plus the stale one give two live chains.
  const r = mount();
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  server.seed(JOB_PATH, job({ status: 'running', matched: 900, filed: 100 }));
  const first = server.hold(JOB_PATH); // the first GET hangs, in flight across the dismiss
  await act(async () => { jest.advanceTimersByTime(POLL); });   // fire poll 1 — its GET is now pending
  expect(server.sent('GET', JOB_PATH).length).toBe(1);

  await act(async () => { r.current.setSheet(null); });          // dismiss mid-GET (bumps the generation)
  await act(async () => { r.current.setSheet({ mode: 'applyRules' }); }); // reopen (arms a fresh timer)
  await act(async () => { first.release(); await Promise.resolve(); });

  // Exactly ONE chain is live now: one delay ⇒ exactly one more GET, not two.
  const before = server.sent('GET', JOB_PATH).length;
  await act(async () => { await jest.advanceTimersByTimeAsync(POLL); });
  expect(server.sent('GET', JOB_PATH).length).toBe(before + 1);
});

it('retry re-runs the SAME variant that failed, not a plain sweep', async () => {
  // A file-this-shop job fails; "Try again" must restart THAT shop's job — with its rule —
  // not a whole-rules sweep. (Finding 1: applyRulesJob is global, so the failed job can be shown
  // and retried from the plain sheet, which would otherwise call startApplyRulesSweep.)
  server.once('GET', JOB_PATH, { body: job({ status: 'failed', error: 'boom' }) });

  const r = mount();
  const group = { rulePattern: 'WOOLWORTHS' } as UncategorizedMerchantGroup;
  await act(async () => { await r.current.fileCharges({ kind: 'shop', group: group, categoryId: 'groceries' }, BIG_RUN); });
  await tick();
  expect(r.current.applyRulesJob?.status).toBe('failed');

  await act(async () => { await r.current.retryApplyRulesJob(); });
  const starts = server.sent('POST', JOBS);
  expect(starts).toHaveLength(2);
  // Both starts carry the SHOP's rule — the retry did not fall back to a rule-less sweep.
  expect(starts[1].body).toEqual({ rule: { value: 'WOOLWORTHS', categoryId: 'groceries' } });
});

it('stops polling on sign-out and never reads status into the next session', async () => {
  const r = mount();
  await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
  server.seed(JOB_PATH, job({ status: 'running', matched: 900, filed: 100 }));
  await tick();
  const callsBefore = server.sent('GET', JOB_PATH).length;

  await act(async () => { setAuthStatus('anon'); });
  expect(r.current.applyRulesJob).toBeNull();

  await tick(3);
  expect(server.sent('GET', JOB_PATH).length).toBe(callsBefore); // no zombie poll
});

// WHIT-560: a Face-ID lock (getStatus() !== 'authed', distinct from sign-out) stops polling and
// drops the job; and the terminal reconcile differs by variant — the "add rule" job prepends the
// minted rule with its NEW badge (skipRules) while "file this shop" refreshes rules normally.
describe('lock and variant edges', () => {
  // How many times the app has checked on a job (any job) so far.
  const polls = () => server.sentUnder('GET', `${JOBS}/`).length;
  const minted: CreatedRule = { id: 'r-new', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' };

  // [G3] a Face-ID lock (getStatus() !== 'authed', NOT sign-out) stops the poll and drops the job.
  // Distinct from the sign-out test: the session epoch is untouched, so a fresh sweep can start after
  // unlock (the lock was released).
  it('[G3] a Face-ID lock stops polling, drops the job, and releases the lock', async () => {
    const r = mount();
    await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'running', matched: 900, filed: 100 }));
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

    const r = mount();
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

    const r = mount();
    await act(async () => { await r.current.fileCharges({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: false }, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'succeeded', matched: 5, filed: 5, createdRule: minted }));
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

    const r = mount();
    const grp = { merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 5, samples: [], firstDate: '2026-01-01', lastDate: '2026-02-01', alsoCatches: [] } as unknown as UncategorizedMerchantGroup;
    await act(async () => { await r.current.fileCharges({ kind: 'shop', group: grp, categoryId: 'groceries' }, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'succeeded', matched: 5, filed: 5, createdRule: minted }));
    const before = invalidate.mock.calls.length;
    await tick();

    expect(queryClient.getQueryData(['rules'])).toEqual([]); // no optimistic prepend
    const keys = invalidatedKeys(invalidate).slice(before);
    expect(keys).toContain('rules'); // refreshed normally
  });
});

// WHIT-565: a job that sits at `running` with no advancing progress for APPLY_RULES_JOB_MAX_STALL_POLLS
// polls raises a NON-destructive `applyRulesStalled` hint: the poll loop keeps running, the job stays
// `running`, and the hint self-clears the moment progress resumes or a terminal state arrives.
describe('stall hint', () => {
  const polls = () => server.sent('GET', JOB_PATH).length;
  const STALL_POLLS = 24;         // APPLY_RULES_JOB_MAX_STALL_POLLS
  // The first running poll sets the baseline signature (counter 0); the counter then increments once
  // per unchanged poll and trips at STALL_POLLS. So the trip lands on the (STALL_POLLS + 1)th poll.
  const POLLS_TO_TRIP = STALL_POLLS + 1;

  it('raises the stall hint after N unchanged polls while the job keeps running (planning phase)', async () => {
    const r = mount();
    await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'running', matched: 0, attempted: 0 }));

    await tick(POLLS_TO_TRIP - 1);
    expect(r.current.applyRulesStalled).toBe(false);   // not yet — one poll short of the threshold

    await tick(1);
    expect(r.current.applyRulesStalled).toBe(true);
    expect(r.current.applyRulesJob?.status).toBe('running');   // NON-destructive: still running

    // Polling continues after the hint — the loop was not stopped.
    const callsAtTrip = polls();
    await tick(2);
    expect(polls()).toBeGreaterThan(callsAtTrip);
  });

  it('never raises the hint while progress keeps advancing', async () => {
    for (let i = 1; i <= POLLS_TO_TRIP + 5; i++) {
      server.once('GET', JOB_PATH, { body: job({ status: 'running', matched: 900, attempted: 10 * i }) });
    }

    const r = mount();
    await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });

    await tick(POLLS_TO_TRIP + 5);
    expect(r.current.applyRulesStalled).toBe(false);
    expect(r.current.applyRulesJob?.status).toBe('running');
  });

  it('clears the hint when progress resumes', async () => {
    const r = mount();
    await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'running', matched: 900, attempted: 100 }));
    await tick(POLLS_TO_TRIP);
    expect(r.current.applyRulesStalled).toBe(true);

    // Progress advances again → the hint self-clears.
    server.seed(JOB_PATH, job({ status: 'running', matched: 900, attempted: 150 }));
    await tick(1);
    expect(r.current.applyRulesStalled).toBe(false);
  });

  it('a terminal state on the stall poll wins over the hint', async () => {
    const r = mount();
    await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'running', matched: 0, attempted: 0 }));
    await tick(POLLS_TO_TRIP - 1);
    expect(r.current.applyRulesStalled).toBe(false);

    // The poll that would trip the hint instead returns succeeded — the terminal path wins.
    server.seed(JOB_PATH, job({ status: 'succeeded', matched: 900, filed: 900 }));
    await tick(1);
    expect(r.current.applyRulesJob?.status).toBe('succeeded');
    expect(r.current.applyRulesStalled).toBe(false);
  });

  // [G1] The stall hint's "Try again" (WHIT-565 decision: Start over) must work even though the job is
  // STILL running and holds the one-heavy-run lock. retryApplyRulesJob tears the run down first
  // (endApplyRulesJob releases the lock), then restarts the SAME variant.
  // FAIL-ON-REVERT: drop the endApplyRulesJob() in retryApplyRulesJob and the active lock refuses the
  // restart — startApplyRulesJob stays at 1 call, res is {ok:false}, and the hint never clears.
  it('[G1] Try again while stalled tears the run down and restarts the same variant', async () => {
    const r = mount();
    await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'running', matched: 0, attempted: 0 }));
    await tick(POLLS_TO_TRIP);
    expect(r.current.applyRulesStalled).toBe(true);

    let res: unknown;
    await act(async () => { res = await r.current.retryApplyRulesJob(); });
    expect(res).toEqual({ status: 'background' });
    expect(server.sent('POST', JOBS)).toHaveLength(2); // abandoned the stuck run, started fresh
    expect(r.current.applyRulesStalled).toBe(false);            // fresh job → hint cleared
    expect(r.current.applyRulesJob?.status).toBe('running');
  });
  // [G4a]/[G4b] The stall signature is matched:attempted, so either one advancing alone resets it.
  it.each([
    ['[G4a] progress via matched alone resets the stall counter', { matched: 5, attempted: 5 }, { matched: 6, attempted: 5 }],
    ['[G4b] progress via attempted alone resets the stall counter', { matched: 900, attempted: 10 }, { matched: 900, attempted: 11 }],
  ])('%s', async (_name, frozen, advanced) => {
    const r = mount();
    await act(async () => { await r.current.fileCharges(SWEEP, BIG_RUN); });
    server.seed(JOB_PATH, job({ status: 'running', ...frozen }));
    await tick(POLLS_TO_TRIP);
    expect(r.current.applyRulesStalled).toBe(true);

    server.seed(JOB_PATH, job({ status: 'running', ...advanced }));
    await tick(1);
    expect(r.current.applyRulesStalled).toBe(false);
  });
});
