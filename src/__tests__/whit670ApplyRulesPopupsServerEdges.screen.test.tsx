// WHIT-670 slice 2 QA — the apply-rules pop-ups now read categories from the fake server through the
// real useCategories. These cover what the moved suites never exercise: a slow, failed, missing or
// changed categories reply, and a signed-out session. The preview / filing writers stay faked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react-native';
import type { AppContext, ApplyRulesResult, FilingResult, FilingTarget, FilingWhen } from '../context';
import type { UncategorizedMerchantGroup } from '../api';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth, setAuthStatus } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP_RECORD } from './support/categories';
import { refreshInAct, useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';
import { queryClient } from '../queryClient';
import { categoriesKey } from '../queries';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
  retryApplyRulesJob: jest.fn<() => Promise<FilingResult>>(),
};

const CATEGORIES = [
  GROCERIES_TOP_RECORD,
  { id: 'fuel', name: 'Fuel', bucket: 'Living', icon: 'car', parent: null },
];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 10, matched: 4, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 4 },
  byRule: [{ ruleId: 'r1', value: 'coles', categoryId: 'groceries', count: 4, samples: [] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 4,
  ...over,
});

const group = (): UncategorizedMerchantGroup => ({
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 4,
  samples: ['COLES 1234 RICHMOND'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
});

const applyRulesState = () => ({ sheet: { mode: 'applyRules' }, toast: null, applyRulesJob: null, ...fns } as unknown as AppContext);
const fileByShopState = () => ({
  sheet: { mode: 'fileByShopConfirm', group: group(), categoryId: 'groceries' }, toast: null, applyRulesJob: null, ...fns,
} as unknown as AppContext);
const addRuleConfirmState = (categoryId = 'groceries') => ({
  sheet: { mode: 'addRuleConfirm', pattern: 'COLES', categoryId, budgetExcluded: false }, toast: null, applyRulesJob: null, ...fns,
} as unknown as AppContext);

async function open(state: AppContext) {
  const view = await openOverlays(state, (next) => { mockState = next; });
  await act(async () => {});
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report() });
});

// [A1] the category name in the breakdown is the SERVER's name, via the real hook.
it('[A1] labels a rule with the category name the server sent', async () => {
  server.seed('/categories', CATEGORIES);
  await open(applyRulesState());

  expect(screen.getByText('"coles" → Groceries · 4 charges')).toBeTruthy();
  expect(server.sent('GET', '/categories').length).toBeGreaterThanOrEqual(1);
});

// [A2] a failed categories read must not blank the sheet: the preview still shows, the label falls
// back to the raw id, and the File button still works.
it('[A2] still previews, with the raw id as label, when the categories read fails', async () => {
  server.fail('/categories', 500);
  await open(applyRulesState());

  expect(fns.previewFiling).toHaveBeenCalledTimes(1);
  expect(screen.getByText('"coles" → groceries · 4 charges')).toBeTruthy();
  expect(screen.queryByText(/Groceries/)).toBeNull();
  expect(screen.getByTestId('apply-rules-apply')).toBeTruthy();
});

// [A3] the label follows a category rename on the server without a second whole-history preview.
it('[A3] relabels after the categories cache refreshes, without re-previewing', async () => {
  server.seed('/categories', CATEGORIES);
  await open(applyRulesState());
  expect(screen.getByText('"coles" → Groceries · 4 charges')).toBeTruthy();

  server.seed('/categories', [{ ...CATEGORIES[0], name: 'Food shop' }, CATEGORIES[1]]);
  await refreshInAct(() => queryClient.invalidateQueries({ queryKey: categoriesKey }));

  await waitFor(() => expect(screen.getByText('"coles" → Food shop · 4 charges')).toBeTruthy());
  expect(fns.previewFiling).toHaveBeenCalledTimes(1);
});

// [A4] locked → the real useIsAuthed hides the sheet and no categories are read; on unlock the
// sheet opens, reads categories once, previews once and labels by name.
it('[A4] hides the sheet and reads nothing while locked, then loads on unlock', async () => {
  server.seed('/categories', CATEGORIES);
  setAuthStatus('locked');
  await open(applyRulesState());

  expect(server.sent('GET', '/categories')).toEqual([]);
  expect(fns.previewFiling).not.toHaveBeenCalled();
  expect(screen.queryByTestId('apply-rules-apply')).toBeNull();

  await act(async () => setAuthStatus('authed'));
  await waitFor(() => expect(screen.getByText('"coles" → Groceries · 4 charges')).toBeTruthy());
  expect(fns.previewFiling).toHaveBeenCalledTimes(1);
});

// [A5] file-by-shop confirm needs the chosen category: while its read is held the sheet draws
// nothing and never previews; once it lands, the preview runs once and the actions appear.
it('[A5] file-by-shop confirm waits for the categories read before previewing', async () => {
  server.seed('/categories', CATEGORIES);
  const held = server.hold('/categories');
  mockState = fileByShopState();
  render(overlaysTree());
  await act(async () => {});

  expect(fns.previewFiling).not.toHaveBeenCalled();
  expect(screen.queryByTestId('file-by-shop-confirm-apply')).toBeNull();

  await act(async () => held.release());
  await waitFor(() => expect(fns.previewFiling).toHaveBeenCalledTimes(1));
  expect(fns.previewFiling).toHaveBeenCalledWith({ kind: 'shop', group: group(), categoryId: 'groceries' });
});

// [A6] add-rule confirm for a category the server no longer has: nothing drawn, nothing previewed.
it('[A6] add-rule confirm for a category missing on the server draws nothing and never previews', async () => {
  server.seed('/categories', CATEGORIES);
  await open(addRuleConfirmState('deleted-cat'));

  expect(fns.previewFiling).not.toHaveBeenCalled();
  expect(screen.queryByTestId('add-rule-confirm-file-all')).toBeNull();
  expect(screen.queryByTestId('add-rule-confirm-apply')).toBeNull();
});

// [A7] ...and for a category the server has, the same sheet previews the new rule once.
it('[A7] add-rule confirm previews the new rule once the server category resolves', async () => {
  server.seed('/categories', CATEGORIES);
  await open(addRuleConfirmState('fuel'));

  expect(fns.previewFiling).toHaveBeenCalledTimes(1);
  expect(fns.previewFiling).toHaveBeenCalledWith({ kind: 'newRule', pattern: 'COLES', categoryId: 'fuel', budgetExcluded: false });
});
