// WHIT-565 — client stall detector for a stuck 'running' apply-rules job (provider side).
//
// A job that sits at `running` with no advancing progress for APPLY_RULES_JOB_MAX_STALL_POLLS polls
// raises a NON-destructive `applyRulesStalled` hint: the poll loop keeps running, the job stays
// `running`, and the hint self-clears the moment progress resumes or a terminal state arrives. These
// lock: it fires at the threshold (incl. the planning phase where matched/attempted sit at 0), never
// fires while progress advances, clears on resumed progress, and always yields to a terminal state.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { ApplyRulesJob } from '../context';
import { queryClient } from '../queryClient';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
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

const POLL = 2500;              // APPLY_RULES_JOB_POLL_DELAY_MS
const STALL_POLLS = 24;         // APPLY_RULES_JOB_MAX_STALL_POLLS
// The first running poll sets the baseline signature (counter 0); the counter then increments once
// per unchanged poll and trips at STALL_POLLS. So the trip lands on the (STALL_POLLS + 1)th poll.
const POLLS_TO_TRIP = STALL_POLLS + 1;

function mount() {
  return renderHook(() => useAppContext(), { wrapper }).result;
}

async function tick(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await jest.advanceTimersByTimeAsync(POLL); });
  }
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); jest.useFakeTimers(); mockStatus = 'authed'; });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

it('raises the stall hint after N unchanged polls while the job keeps running (planning phase)', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 0, attempted: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });

  await tick(POLLS_TO_TRIP - 1);
  expect(r.current.applyRulesStalled).toBe(false);   // not yet — one poll short of the threshold

  await tick(1);
  expect(r.current.applyRulesStalled).toBe(true);
  expect(r.current.applyRulesJob?.status).toBe('running');   // NON-destructive: still running

  // Polling continues after the hint — the loop was not stopped.
  const callsAtTrip = mockApi.getApplyRulesJob.mock.calls.length;
  await tick(2);
  expect(mockApi.getApplyRulesJob.mock.calls.length).toBeGreaterThan(callsAtTrip);
});

it('never raises the hint while progress keeps advancing', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  let attempted = 0;
  mockApi.getApplyRulesJob.mockImplementation(async () =>
    job({ status: 'running', matched: 900, attempted: (attempted += 10) }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });

  await tick(POLLS_TO_TRIP + 5);
  expect(r.current.applyRulesStalled).toBe(false);
  expect(r.current.applyRulesJob?.status).toBe('running');
});

it('clears the hint when progress resumes', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, attempted: 100 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP);
  expect(r.current.applyRulesStalled).toBe(true);

  // Progress advances again → the hint self-clears.
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 900, attempted: 150 }));
  await tick(1);
  expect(r.current.applyRulesStalled).toBe(false);
});

it('a terminal state on the stall poll wins over the hint', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'running', matched: 0, attempted: 0 }));

  const r = mount();
  await act(async () => { await r.current.startApplyRulesSweep(); });
  await tick(POLLS_TO_TRIP - 1);
  expect(r.current.applyRulesStalled).toBe(false);

  // The poll that would trip the hint instead returns succeeded — the terminal path wins.
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'succeeded', matched: 900, filed: 900 }));
  await tick(1);
  expect(r.current.applyRulesJob?.status).toBe('succeeded');
  expect(r.current.applyRulesStalled).toBe(false);
});
