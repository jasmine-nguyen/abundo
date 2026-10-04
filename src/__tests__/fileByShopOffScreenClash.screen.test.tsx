// WHIT-517/WHIT-557 — [A29] the FileByShop off-screen 409-CLASH toast. fileByShopSheetGaps covers a
// success ([A24]) and a non-clash failure ([A24b]) settling after the sheet is dismissed, but NOT a
// clash. addRulePreviewGaps covers the AddRule side of this ([A36]); the FileByShop side is the
// asymmetric gap the shell refactor should lock — its `clashToast` closure is otherwise exercised by
// no test at all (the on-screen clash uses setPhase('clash'), a different path). Fail-on-revert: drop
// the `else clashToast()` on the shell's clash branch and a clash landing off screen is dropped
// silently — no toast.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, FilingResult, FilingTarget, FilingWhen } from '../context';
import type { ApplyRulesResult, UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const CATEGORIES = [
  GROCERIES_TOP,
];

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
};

const group = (over: Partial<UncategorizedMerchantGroup> = {}): UncategorizedMerchantGroup => ({
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20,
  samples: ['COLES 1234 RICHMOND'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
  ...over,
});

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 20, matched: 20, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 20 }, byRule: [], skippedRules: [],
  filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 20, createdRule: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mountConfirm(g = group(), categoryId = 'groceries') {
  server.seed('/categories', CATEGORIES);
  const state = { sheet: { mode: 'fileByShopConfirm', group: g, categoryId }, toast: null, ...fns } as unknown as AppContext;
  const utils = await openOverlays(state, (next) => { mockState = next; });
  await act(async () => {}); // let the mount-time preview settle
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// [A29] The sheet is dismissable while the write is in flight. A 409-clash settling off screen must
// TOAST the clash (not drop it), must NOT setPhase into the clash card on the unmounted sheet, and
// must NOT navigate. This is the off-screen clash branch neither fileByShopSheetGaps test reaches.
it('[A29] toasts a 409-clash that settles after the sheet is dismissed', async () => {
  const pending = deferred<FilingResult>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockReturnValue(pending.promise);
  const { rerender } = await mountConfirm();

  await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); }); // start write
  mockState = { ...mockState, sheet: null } as unknown as AppContext;                            // dismiss
  await act(async () => { rerender(overlaysTree()); });

  await act(async () => { pending.resolve({ status: 'clash', error: new ApiError(409, null), background: false }); });

  expect(fns.showToast).toHaveBeenCalledWith('You already have a rule filing Coles somewhere else.');
  expect(fns.setSheet).not.toHaveBeenCalledWith({ mode: 'fileByShopList' });
});
