// WHIT-560 — the async job's arms of the "Apply my rules" sheet.
//
// The sheet renders directly off `applyRulesJob` (the provider's poll state): a running job shows a
// progress bar (filed / the JOB's matched, not the preview's), a done job its summary, a failed job
// a retry. Over the per-run cap the preview promotes "Apply to all history" (the uncapped background
// sweep) to primary and demotes the one-round instant file. A stalled running job (WHIT-565) shows
// a hint with an optional retry. The file-this-shop and add-rule confirm sheets run the same job
// view and their own uncapped starts. Context is mocked, like the sync sheet.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, ApplyRulesResult, ApplyRulesJob, FilingResult, FilingTarget, FilingWhen } from '../context';
import { APPLY_RULES_MAX_WRITES } from '../context';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP_RECORD } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';
import { applyRulesJob, applyRulesReport } from './support/applyRulesReport';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
  saveManualRule: jest.fn(),
  retryApplyRulesJob: jest.fn<() => Promise<FilingResult>>(),
};

const CATEGORIES = [GROCERIES_TOP_RECORD];

const report = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
  rulesConsidered: 2, unfiled: 639, matched: 512, byCategory: { groceries: 512 }, alreadyFiled: [], remaining: 512,
  ...over,
});

/** Mount the apply-rules sheet with a given job state (null = the preview arm). */
async function mountWith(applyRulesJob: ApplyRulesJob | null, preview: ApplyRulesResult | null = report(), applyRulesStalled = false) {
  fns.previewFiling.mockResolvedValue(preview ? { status: 'filed', report: preview } : { status: 'failed', background: false });
  server.seed('/categories', CATEGORIES);
  const state = { sheet: { mode: 'applyRules' }, toast: null, applyRulesJob, applyRulesStalled, ...fns } as unknown as AppContext;
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
  // The one-round instant file is NOT the background sweep.
  expect(fns.fileCharges).not.toHaveBeenCalledWith({ kind: 'sweep' }, { now: true });
});

// --- running ------------------------------------------------------------------

it('shows a progress bar keyed on the job matched, and leaves it running on cancel', async () => {
  await mountWith(applyRulesJob({ status: 'running', matched: 900, filed: 450 }));

  expect(screen.getByText(/Filed 450 of 900 charges/)).toBeTruthy();

  fireEvent.press(screen.getByTestId('apply-rules-cancel'));
  expect(fns.setSheet).toHaveBeenCalledWith(null); // the job keeps running server-side
});

// --- stalled / failed ------------------------------------------------------------

// WHIT-565: a stalled job is NOT failed — the sheet swaps the running view for a hint with an
// OPTIONAL Try again that runs the same variant-aware retry.
it('shows the stall hint + Try again on a stalled running job, and Try again runs the retry path', async () => {
  fns.retryApplyRulesJob.mockResolvedValue({ status: 'background' });
  await mountWith(applyRulesJob({ status: 'running', matched: 0, attempted: 0 }), report(), true);

  expect(screen.getByTestId('apply-rules-job-stalled')).toBeTruthy();
  expect(screen.queryByTestId('apply-rules-job-running')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-job-stalled-retry')); });
  expect(fns.retryApplyRulesJob).toHaveBeenCalledTimes(1);
});

it('offers retry on failure, re-running the same job variant', async () => {
  fns.retryApplyRulesJob.mockResolvedValue({ status: 'background' });
  await mountWith(applyRulesJob({ status: 'failed', error: 'network' }));

  expect(screen.getByTestId('apply-rules-job-failed')).toBeTruthy();
  fireEvent.press(screen.getByTestId('apply-rules-job-retry'));
  // Retry goes through the provider's variant-aware retry, NOT a plain sweep.
  expect(fns.retryApplyRulesJob).toHaveBeenCalledTimes(1);
  expect(fns.fileCharges).not.toHaveBeenCalled();
});

// --- the inline variants: file-this-shop and add-rule confirm sheets ------------
describe('inline variants', () => {
  const OVER = APPLY_RULES_MAX_WRITES + 200; // guaranteed over the per-call cap

  const group = (over: Partial<UncategorizedMerchantGroup> = {}): UncategorizedMerchantGroup => ({
    merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: OVER,
    samples: ['COLES 1234 RICHMOND'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [], ...over,
  });

  const variantReport = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
    rulesConsidered: 1, unfiled: OVER, matched: OVER, byCategory: { groceries: OVER },
    byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: OVER, samples: ['COLES 1'] }],
    alreadyFiled: [], remaining: OVER, createdRule: null,
    ...over,
  });

  async function mountFileByShop(applyRulesJob: ApplyRulesJob | null, g = group()) {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: variantReport({ matched: g.count }) });
    server.seed('/categories', CATEGORIES);
    const state = {
      sheet: { mode: 'fileByShopConfirm', group: g, categoryId: 'groceries' }, toast: null, applyRulesJob, ...fns,
    } as unknown as AppContext;
    await openOverlays(state, (next) => { mockState = next; });
    await act(async () => {});
  }

  async function mountAddRule(applyRulesJob: ApplyRulesJob | null, budgetExcluded = false, pattern = 'COLES') {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: variantReport() });
    server.seed('/categories', CATEGORIES);
    const state = {
      sheet: { mode: 'addRuleConfirm', pattern, categoryId: 'groceries', budgetExcluded }, toast: null, applyRulesJob, ...fns,
    } as unknown as AppContext;
    await openOverlays(state, (next) => { mockState = next; });
    await act(async () => {});
  }

  it('[V1] file-this-shop capped promotes Apply-to-all and starts the file-by-shop job with the pair', async () => {
    const g = group();
    fns.fileCharges.mockResolvedValue({ status: 'background' });
    await mountFileByShop(null, g);

    expect(screen.getByTestId('file-by-shop-confirm-apply-all')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply-all')); });
    expect(fns.fileCharges).toHaveBeenCalledWith({ kind: 'shop', group: g, categoryId: 'groceries' }, { matched: OVER });
    expect(fns.fileCharges).not.toHaveBeenCalledWith(expect.anything(), { now: true }); // NOT the one-round sync path
  });

  it('[V3] a running job renders the shared job view INSIDE the file-by-shop sheet (not the preview)', async () => {
    await mountFileByShop(applyRulesJob({ status: 'running', matched: 900, filed: 450 }));

    expect(screen.getByTestId('apply-rules-job-running')).toBeTruthy();
    expect(screen.getByText(/Filed 450 of 900 charges/)).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-confirm-apply-all')).toBeNull(); // the preview is gone
  });

  it('[V5] add-rule capped promotes file-all and starts the new-rule job with the budgetExcluded flag', async () => {
    fns.fileCharges.mockResolvedValue({ status: 'background' });
    await mountAddRule(null, true);

    expect(screen.getByTestId('add-rule-confirm-file-all')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file-all')); });
    expect(fns.fileCharges).toHaveBeenCalledWith({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: true }, { matched: OVER });
    expect(fns.fileCharges).not.toHaveBeenCalledWith(expect.anything(), { now: true });
  });

  // A 409 clash from the async start toasts the variant's own clash copy, not the generic one.
  it.each([
    ['[V2] a 409 clash from the file-by-shop async start toasts the shop-specific clash copy', () => mountFileByShop(null, group({ merchant: 'Coles' })), 'file-by-shop-confirm-apply-all', 'You already have a rule filing Coles somewhere else.'],
    ['[V6] a 409 clash from the add-rule async start toasts the pattern-specific clash copy', () => mountAddRule(null, false, 'COLES'), 'add-rule-confirm-file-all', 'You already have a rule for “COLES”.'],
  ])('%s', async (_name, open, button, toast) => {
    fns.fileCharges.mockResolvedValue({ status: 'clash', error: new ApiError(409, null), background: true });
    await open();

    await act(async () => { fireEvent.press(screen.getByTestId(button)); });
    expect(fns.showToast).toHaveBeenCalledWith(toast);
  });
});
