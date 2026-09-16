// WHIT-565 — the stall hint's arm of the apply-rules job sheet.
//
// When the provider flags `applyRulesStalled` on a still-running job, the sheet swaps the running
// copy for a reassuring "taking longer than expected" message plus an OPTIONAL Try again (the same
// variant-aware retry). The job is NOT failed — it keeps running in the background.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, ApplyRulesResult, ApplyRulesJob, ApplyRulesJobStart } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  previewRuleApplication: jest.fn<() => Promise<ApplyRulesResult | null>>(),
  applyRulesToHistory: jest.fn<() => Promise<ApplyRulesResult | null>>(),
  startApplyRulesSweep: jest.fn<() => Promise<ApplyRulesJobStart>>(),
  retryApplyRulesJob: jest.fn<() => Promise<ApplyRulesJobStart>>(),
};

const CATEGORIES = [{ id: 'groceries', name: 'Groceries' }];

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

async function mountWith(applyRulesJob: ApplyRulesJob | null, stalled: boolean) {
  fns.retryApplyRulesJob.mockResolvedValue({ ok: true });
  mockState = { sheet: { mode: 'applyRules' }, toast: null, categories: CATEGORIES,
    applyRulesJob, applyRulesStalled: stalled, ...fns } as unknown as AppContext;
  render(<Overlays />);
  await act(async () => {});
  return screen;
}

beforeEach(() => { jest.clearAllMocks(); });

it('shows the "taking longer than expected" hint + Try again when a running job is stalled', async () => {
  await mountWith(job({ status: 'running', matched: 0, attempted: 0 }), true);

  expect(screen.getByTestId('apply-rules-job-stalled')).toBeTruthy();
  expect(screen.queryByTestId('apply-rules-job-running')).toBeNull();
  expect(screen.getByText('This is taking longer than expected')).toBeTruthy();
  expect(screen.getByTestId('apply-rules-job-stalled-retry')).toBeTruthy();
});

it('Try again on the stall hint runs the existing retry path', async () => {
  await mountWith(job({ status: 'running' }), true);

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-job-stalled-retry')); });
  expect(fns.retryApplyRulesJob).toHaveBeenCalledTimes(1);
});

it('a running job that is NOT stalled shows the normal running arm, no hint', async () => {
  await mountWith(job({ status: 'running', matched: 900, filed: 300 }), false);

  expect(screen.getByTestId('apply-rules-job-running')).toBeTruthy();
  expect(screen.queryByTestId('apply-rules-job-stalled')).toBeNull();
  expect(screen.queryByTestId('apply-rules-job-stalled-retry')).toBeNull();
});
