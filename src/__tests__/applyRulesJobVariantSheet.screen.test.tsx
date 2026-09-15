// WHIT-560 — the INLINE variants of the async job: the file-this-shop and add-rule confirm sheets.
//
// applyRulesJobSheet.screen.test.tsx covers only the PLAIN "Apply my rules" sheet. Gaps here:
//   - each confirm sheet, when over the per-call cap, promotes its own uncapped background start
//     (*-apply-all / *-file-all) and tapping it calls the RIGHT variant starter with the RIGHT args;
//   - a 409 clash from that async start toasts the variant's clash copy (not the generic one);
//   - once applyRulesJob is non-null the SAME ApplyRulesJobView renders INSIDE that confirm sheet;
//   - the progress bar clamps to 100% when filed exceeds matched (a late count race).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, FileByShopOutcome, ApplyRulesJobStart, ApplyRulesJob } from '../context';
import type { ApplyRulesResult, UncategorizedMerchantGroup, UncategorizedMerchants } from '../api';
import { APPLY_RULES_MAX_WRITES } from '../context';
import { ApiError } from '../apiError';

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
  previewFileByShop: jest.fn<(g: UncategorizedMerchantGroup, c: string) => Promise<FileByShopOutcome>>(),
  fileByShop: jest.fn<(g: UncategorizedMerchantGroup, c: string) => Promise<FileByShopOutcome>>(),
  startFileByShopJob: jest.fn<(g: UncategorizedMerchantGroup, c: string) => Promise<ApplyRulesJobStart>>(),
  previewNewRule: jest.fn<(p: string, c: string, b?: boolean) => Promise<FileByShopOutcome>>(),
  fileNewRule: jest.fn<(p: string, c: string, b?: boolean) => Promise<FileByShopOutcome>>(),
  saveManualRule: jest.fn(),
  startNewRuleJob: jest.fn<(p: string, c: string, b?: boolean) => Promise<ApplyRulesJobStart>>(),
  retryApplyRulesJob: jest.fn<() => Promise<ApplyRulesJobStart>>(),
};

const CATEGORIES = [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null }];
const OVER = APPLY_RULES_MAX_WRITES + 200; // guaranteed over the per-call cap

const group = (over: Partial<UncategorizedMerchantGroup> = {}): UncategorizedMerchantGroup => ({
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: OVER,
  samples: ['COLES 1234 RICHMOND'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [], ...over,
});
const merchants = (g: UncategorizedMerchantGroup): UncategorizedMerchants => ({ unfiled: g.count, groups: [g], ungrouped: { count: 0, samples: [] } });

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: OVER, matched: OVER, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: OVER }, byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: OVER, samples: ['COLES 1'] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: OVER, createdRule: null, ...over,
});

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

async function mountFileByShop(applyRulesJob: ApplyRulesJob | null, g = group()) {
  fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: g.count }) });
  mockState = {
    sheet: { mode: 'fileByShopConfirm', group: g, categoryId: 'groceries' }, toast: null,
    categories: CATEGORIES, uncategorizedMerchants: merchants(g), applyRulesJob, ...fns,
  } as unknown as AppContext;
  render(<Overlays />);
  await act(async () => {});
}

async function mountAddRule(applyRulesJob: ApplyRulesJob | null, budgetExcluded = false, pattern = 'COLES') {
  fns.previewNewRule.mockResolvedValue({ ok: true, report: report() });
  mockState = {
    sheet: { mode: 'addRuleConfirm', pattern, categoryId: 'groceries', budgetExcluded }, toast: null,
    categories: CATEGORIES, applyRulesJob, ...fns,
  } as unknown as AppContext;
  render(<Overlays />);
  await act(async () => {});
}

// The FIRST mount here boots the whole RN module graph AND the file-by-shop confirm sheet; under the
// v8 coverage run every line is instrumented, so that cold boot crosses Jest's 5s default and the
// first test times out (WHIT-433's "slowness, not a hang"). The screen project's testTimeout:15000
// is meant to cover this but is silently ignored under Jest 30's multi-project config (a 6s probe
// test times out at 5s), so set the ceiling locally. Revert to the default and this file reddens
// under `--coverage`. (Follow-up card: make the project-level testTimeout actually apply.)
jest.setTimeout(15000);

beforeEach(() => { jest.clearAllMocks(); });

// --- file-this-shop -----------------------------------------------------------

it('[V1] file-this-shop capped promotes Apply-to-all and starts the file-by-shop job with the pair', async () => {
  const g = group();
  fns.startFileByShopJob.mockResolvedValue({ ok: true });
  await mountFileByShop(null, g);

  expect(screen.getByTestId('file-by-shop-confirm-apply-all')).toBeTruthy();
  expect(screen.getByText(`File up to ${APPLY_RULES_MAX_WRITES} now`)).toBeTruthy(); // demoted, still there
  await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply-all')); });
  expect(fns.startFileByShopJob).toHaveBeenCalledWith(g, 'groceries');
  expect(fns.fileByShop).not.toHaveBeenCalled(); // NOT the one-round sync path
});

it('[V2] a 409 clash from the file-by-shop async start toasts the shop-specific clash copy', async () => {
  fns.startFileByShopJob.mockResolvedValue({ ok: false, clash: new ApiError(409, null) });
  await mountFileByShop(null, group({ merchant: 'Coles' }));

  await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply-all')); });
  expect(fns.showToast).toHaveBeenCalledWith('You already have a rule filing Coles somewhere else.');
});

it('[V3] a running job renders the shared job view INSIDE the file-by-shop sheet (not the preview)', async () => {
  await mountFileByShop(job({ status: 'running', matched: 900, filed: 450 }));

  expect(screen.getByTestId('apply-rules-job-running')).toBeTruthy();
  expect(screen.getByText(/Filed 450 of 900 charges/)).toBeTruthy();
  expect(screen.queryByTestId('file-by-shop-confirm-apply-all')).toBeNull(); // the preview is gone
});

it('[V4] a failed job-view retry re-runs the provider variant retry, not a plain sweep', async () => {
  // Finding 1 fix: retry is centralized in the provider (retryApplyRulesJob), which restarts whatever
  // variant started the job. The sheet must route "Try again" there — never call a variant starter
  // directly, which would restart the WRONG variant when the job was started from another sheet.
  await mountFileByShop(job({ status: 'failed', error: 'network' }), group());

  fireEvent.press(screen.getByTestId('apply-rules-job-retry'));
  expect(fns.retryApplyRulesJob).toHaveBeenCalledTimes(1);
  expect(fns.startFileByShopJob).not.toHaveBeenCalled(); // no direct variant start from the job view
});

// --- add-rule -----------------------------------------------------------------

it('[V5] add-rule capped promotes file-all and starts the new-rule job with the budgetExcluded flag', async () => {
  fns.startNewRuleJob.mockResolvedValue({ ok: true });
  await mountAddRule(null, true);

  expect(screen.getByTestId('add-rule-confirm-file-all')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file-all')); });
  expect(fns.startNewRuleJob).toHaveBeenCalledWith('COLES', 'groceries', true);
  expect(fns.fileNewRule).not.toHaveBeenCalled();
});

it('[V6] a 409 clash from the add-rule async start toasts the pattern-specific clash copy', async () => {
  fns.startNewRuleJob.mockResolvedValue({ ok: false, clash: new ApiError(409, null) });
  await mountAddRule(null, false, 'COLES');

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file-all')); });
  expect(fns.showToast).toHaveBeenCalledWith('You already have a rule for “COLES”.');
});

it('[V7] a running job renders the shared job view INSIDE the add-rule sheet', async () => {
  await mountAddRule(job({ status: 'running', matched: 900, filed: 450 }));
  expect(screen.getByTestId('apply-rules-job-running')).toBeTruthy();
  expect(screen.queryByTestId('add-rule-confirm-file-all')).toBeNull();
});

// --- the shared progress bar clamp -------------------------------------------

it('[V8] the progress bar clamps to 100% when filed exceeds matched (late-count race)', async () => {
  await mountFileByShop(job({ status: 'running', matched: 800, filed: 1000 }));

  const track = screen.getByTestId('apply-rules-job-progress');
  const fill = track.children[0] as unknown as { props: { style: unknown } };
  const flat = Array.isArray(fill.props.style) ? Object.assign({}, ...fill.props.style) : fill.props.style;
  expect((flat as { width: string }).width).toBe('100%');
});
