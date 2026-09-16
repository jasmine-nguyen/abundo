// WHIT-565 — ADVERSARIAL GAP tests for the apply-rules stall hint (provider side).
// Independent of the implementer's applyRulesJobStall.provider.screen.test.tsx (threshold fire,
// advancing never fires, clears on resume, terminal wins). These probe the seams:
//   [G1] "Try again" while STILL running (stalled) tears the run down and restarts (WHIT-565 decision).
//   [G2] begin's stall reset is load-bearing after a LOCK leak (endApplyRulesJob never ran).
//   [G3] a network throw is NEUTRAL to the stall counter (never reaches the running branch).
//   [G4] progress via matched-alone and attempted-alone each reset the counter (signature is m:a).
//   [G5] a mid-run jump then freeze restarts the stall clock from the LAST jump, not from mount.
//   [G6] a teardown between a stall poll firing and resolving must not trip a dead job.
//   [G7] a 404 / network-cap terminal on the stall poll clears the hint and sets the error.
//   [G8] the hint survives a dismiss + reopen of the SAME running job.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { ApplyRulesJob } from '../context';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (status: typeof mockStatus) => {
  mockStatus = status;
  mockListeners.forEach((l) => l());
};
jest.mock('../api');
jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

const POLL = 2500;
const STALL_POLLS = 24;
const POLLS_TO_TRIP = STALL_POLLS + 1; // first poll sets baseline (counter 0); trips on the 25th.

function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL); });
  }
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); jest.useFakeTimers(); mockStatus = 'authed'; });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

// [G1] The stall hint's "Try again" (WHIT-565 decision: Start over) must work even though the job is
// STILL running and holds the one-heavy-run lock. retryApplyRulesJob tears the run down first
// (endApplyRulesJob releases the lock), then restarts the SAME variant.
// FAIL-ON-REVERT: drop the endApplyRulesJob() in retryApplyRulesJob and the active lock refuses the
// restart — startApplyRulesJob stays at 1 call, res is {ok:false}, and the hint never clears.
it('[G1] Try again while stalled tears the run down and restarts the same variant', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 0, attempted: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  let res: unknown;
  await act(async () => { res = await r.current.retryApplyRulesJob(); });
  expect(res).toEqual({ ok: true });
  expect(mockApi.startApplyRulesJob).toHaveBeenCalledTimes(2); // abandoned the stuck run, started fresh
  expect(r.current.applyRulesStalled).toBe(false);            // fresh job → hint cleared
  expect(r.current.applyRulesJob?.status).toBe('running');
});

// [G2] After a LOCK, the lock effect frees the active lock + drops the job but does NOT reset the
// stall refs (only endApplyRulesJob/beginApplyRulesJob do). A fresh sweep must therefore reset them
// in beginApplyRulesJob, or the leaked counter (24) + leaked signature ('0:0') re-trip on the very
// first poll of the NEW job. This is why begin's reset is load-bearing (retry never calls end).
it('[G2] a fresh sweep after a lock leak does not re-trip the hint on the first poll', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 0, attempted: 0 }));

  const r = mount();
  await act(async () => { r.current.setSheet({ mode: 'applyRules' } as never); });
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  // Lock (drops job, frees lock, LEAVES stall refs) then unlock.
  await act(async () => { mockSetStatus('locked'); });
  expect(r.current.applyRulesJob).toBeNull();
  await act(async () => { mockSetStatus('authed'); });

  // Fresh sweep: begin must reset the stall refs. First poll (0:0) must NOT re-trip.
  await act(async () => { r.current.setSheet({ mode: 'applyRules' } as never); });
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(1);
  expect(r.current.applyRulesStalled).toBe(false); // leaked counter would re-trip here
  expect(r.current.applyRulesJob?.status).toBe('running');
});

// [G3] A thrown GET (offline) goes to catch and NEVER reaches the running branch, so it neither
// resets nor increments the stall counter — it is neutral. Interleaving throws (below the net cap)
// delays the trip by their count but does not reset progress already accrued.
it('[G3] a network throw is neutral to the stall counter (does not reset it)', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  let call = 0;
  mockApi.getApplyRulesJob.mockImplementation(async () => {
    call += 1;
    if (call >= 25 && call <= 27) throw new Error('offline'); // polls 25,26,27 drop
    return job({ status: 'running', matched: 0, attempted: 0 });
  });

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(24);                                    // counter 23, not stalled
  expect(r.current.applyRulesStalled).toBe(false);
  await tick(3);                                     // three offline throws — counter untouched
  expect(r.current.applyRulesStalled).toBe(false);
  expect(r.current.applyRulesJob?.status).toBe('running'); // blips did not fail it
  await tick(1);                                     // one more running poll → counter 24 → trip
  expect(r.current.applyRulesStalled).toBe(true);
});

// [G4a] matched advances while attempted is frozen → signature changes → counter resets.
it('[G4a] progress via matched alone resets the stall counter', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 5, attempted: 5 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 6, attempted: 5 })); // matched only
  await tick(1);
  expect(r.current.applyRulesStalled).toBe(false);
});

// [G4b] attempted advances while matched is frozen → signature changes → counter resets.
it('[G4b] progress via attempted alone resets the stall counter', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, attempted: 10 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, attempted: 11 })); // attempted only
  await tick(1);
  expect(r.current.applyRulesStalled).toBe(false);
});

// [G5] A write-phase job that jumps (attempted 0→50) then freezes must count the stall from the
// LAST jump, not from mount — otherwise an early burst of progress would leave a healthy job on a
// nearly-expired clock and it would nag almost immediately after stalling.
it('[G5] a mid-run jump restarts the stall clock from the jump, not from mount', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 100, attempted: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(10); // 10 unchanged polls at 100:0 — counter climbing toward the trip
  expect(r.current.applyRulesStalled).toBe(false);

  // The write phase lands a batch: attempted jumps 0→50 (signature changes → counter resets to 0).
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 100, attempted: 50 }));
  await tick(1); // baseline for the new signature (counter 0)

  // Now frozen at 100:50. It must take the FULL window from here — 23 more unchanged polls short.
  await tick(STALL_POLLS - 1);
  expect(r.current.applyRulesStalled).toBe(false);
  await tick(1);
  expect(r.current.applyRulesStalled).toBe(true);
});

// [G6] A stall poll fires, its GET is in flight, the sheet is dismissed (bumps the generation), then
// the GET resolves running/0:0 on the poll that WOULD have tripped. The superseded() guard returns
// before touching the counter — a dead job must not raise the hint.
it('[G6] a teardown between a stall poll firing and resolving does not trip the hint', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  const hanging = deferred<ApplyRulesJob>();
  let call = 0;
  mockApi.getApplyRulesJob.mockImplementation(() => {
    call += 1;
    if (call === POLLS_TO_TRIP) return hanging.promise;                 // the tripping poll hangs
    return Promise.resolve(job({ status: 'running', matched: 0, attempted: 0 }));
  });

  const r = mount();
  await act(async () => { r.current.setSheet({ mode: 'applyRules' } as never); });
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP - 1);        // counter 23, not stalled
  expect(r.current.applyRulesStalled).toBe(false);

  await act(async () => { jest.advanceTimersByTime(POLL); }); // fire the tripping poll — GET pending
  await act(async () => { r.current.setSheet(null); });        // dismiss mid-GET → generation bump
  await act(async () => { hanging.resolve(job({ status: 'running', matched: 0, attempted: 0 })); await Promise.resolve(); });

  expect(r.current.applyRulesStalled).toBe(false); // superseded — a dead job did not trip
});

// [G7a] A 404 (expired id) on the poll that would have tripped is terminal: the hint clears and the
// job is marked failed/expired.
it('[G7a] a 404 on the stall poll clears the hint and fails the job (expired)', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 0, attempted: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  mockApi.getApplyRulesJob.mockRejectedValue(new ApiError(404, null));
  await tick(1);
  expect(r.current.applyRulesStalled).toBe(false);
  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'expired' });
});

// [G7b] Hitting the consecutive-network-error cap while stalled is terminal: the hint clears and the
// job is marked failed/network.
it('[G7b] the network-error cap while stalled clears the hint and fails the job (network)', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 0, attempted: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  mockApi.getApplyRulesJob.mockRejectedValue(new Error('offline'));
  await tick(5); // APPLY_RULES_JOB_MAX_NET_ERRORS
  expect(r.current.applyRulesStalled).toBe(false);
  expect(r.current.applyRulesJob).toMatchObject({ status: 'failed', error: 'network' });
});

// [G8] Dismissing the sheet stops polling but keeps the job alive (lock held) and does NOT touch the
// stall refs. The hint must survive a dismiss + reopen of the SAME running job.
it('[G8] the stall hint survives a dismiss and reopen of the same running job', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 0, attempted: 0 }));

  const r = mount();
  await act(async () => { r.current.setSheet({ mode: 'applyRules' } as never); });
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  await act(async () => { r.current.setSheet(null); });   // dismiss: stops polling, job stays alive
  expect(r.current.applyRulesJob?.status).toBe('running'); // active job not dropped
  expect(r.current.applyRulesStalled).toBe(true);          // hint preserved across dismiss

  await act(async () => { r.current.setSheet({ mode: 'applyRules' } as never); }); // reopen
  expect(r.current.applyRulesStalled).toBe(true);          // still there on reopen
  await tick(1);                                            // polling resumed, still no progress
  expect(r.current.applyRulesStalled).toBe(true);
});
