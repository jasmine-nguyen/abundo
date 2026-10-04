// WHIT-560 — the async job's arms of the "Apply my rules" sheet.
//
// The sheet renders directly off `applyRulesJob` (the provider's poll state): a running job shows a
// progress bar (filed / the JOB's matched, not the preview's), a done job its summary, a failed job
// a retry. Over the per-run cap the preview promotes "Apply to all history" (the uncapped background
// sweep) to primary and demotes the one-round instant file. Context is mocked, like the sync sheet.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, ApplyRulesResult, ApplyRulesJob, FilingResult, FilingTarget, FilingWhen } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';
import { GROCERIES_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
  retryApplyRulesJob: jest.fn<() => Promise<FilingResult>>(),
};

const CATEGORIES = [GROCERIES_RECORD];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 2, unfiled: 639, matched: 512, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 512 }, byRule: [], skippedRules: [],
  filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 512, ...over,
});

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

/** Mount the apply-rules sheet with a given job state (null = the preview arm). */
async function mountWith(applyRulesJob: ApplyRulesJob | null, preview: ApplyRulesResult | null = report()) {
  fns.previewFiling.mockResolvedValue(preview ? { status: 'filed', report: preview } : { status: 'failed', background: false });
  server.seed('/categories', CATEGORIES);
  const state = { sheet: { mode: 'applyRules' }, toast: null, applyRulesJob, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
  await act(async () => {});
  return screen;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// --- the capped preview (decision A: async primary) --------------------------

it('promotes the background sweep to primary over the per-run cap', async () => {
  await mountWith(null, report({ matched: 512 }));

  fireEvent.press(screen.getByTestId('apply-rules-apply-all'));
  expect(fns.fileCharges).toHaveBeenCalledTimes(1);
  expect(fns.fileCharges).toHaveBeenCalledWith({ kind: 'sweep' }, { matched: 512 });
  // The one-round instant file is still there, demoted.
  expect(screen.getByText('File up to 300 now')).toBeTruthy();
  // and it is NOT the background sweep.
  expect(fns.fileCharges).not.toHaveBeenCalledWith({ kind: 'sweep' }, { now: true });
});

// --- running ------------------------------------------------------------------

it('shows a progress bar keyed on the job matched, and leaves it running on cancel', async () => {
  await mountWith(job({ status: 'running', matched: 900, filed: 450 }));

  expect(screen.getByTestId('apply-rules-job-running')).toBeTruthy();
  expect(screen.getByTestId('apply-rules-job-progress')).toBeTruthy();
  expect(screen.getByText(/Filed 450 of 900 charges/)).toBeTruthy();

  fireEvent.press(screen.getByTestId('apply-rules-cancel'));
  expect(fns.setSheet).toHaveBeenCalledWith(null); // the job keeps running server-side
});

it('shows no bar before the worker has planned (matched 0)', async () => {
  await mountWith(job({ status: 'running', matched: 0, filed: 0 }));

  expect(screen.getByTestId('apply-rules-job-running')).toBeTruthy();
  expect(screen.queryByTestId('apply-rules-job-progress')).toBeNull();
  expect(screen.getByText(/Starting…/)).toBeTruthy();
});

// --- done / failed ------------------------------------------------------------

it('shows the done summary on success', async () => {
  await mountWith(job({ status: 'succeeded', matched: 900, filed: 900, remaining: 0 }));

  expect(screen.getByTestId('apply-rules-job-done')).toBeTruthy();
  expect(screen.getByText('Filed 900 charges')).toBeTruthy();
});

it('offers retry on failure, re-running the same job variant', async () => {
  fns.retryApplyRulesJob.mockResolvedValue({ status: 'background' });
  await mountWith(job({ status: 'failed', error: 'network' }));

  expect(screen.getByTestId('apply-rules-job-failed')).toBeTruthy();
  fireEvent.press(screen.getByTestId('apply-rules-job-retry'));
  // Retry goes through the provider's variant-aware retry, NOT a plain sweep.
  expect(fns.retryApplyRulesJob).toHaveBeenCalledTimes(1);
  expect(fns.fileCharges).not.toHaveBeenCalled();
});
