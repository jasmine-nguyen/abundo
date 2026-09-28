// WHIT-558 gap — the AddRuleConfirmSheet threads the "keep out of budget" flag from the sheet
// payload into ALL THREE of its write paths: the mount-time dry-run (previewNewRule), the
// mint-and-file commit (fileNewRule) and the future-only "Add rule only" (saveManualRule). The
// implementer's addRulePreview.screen.test.tsx only ever mounts with the flag OFF (asserts the
// literal `false`), so the TRUE path — the whole point of the toggle reaching the confirm step —
// is unpinned. Fail-on-revert: drop `budgetExcluded` from any of the three call sites in
// AddRuleConfirmSheet and the matching assertion reddens.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, FilingResult, FilingTarget, FilingWhen } from '../context';
import type { ApplyRulesResult } from '../api';

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
  saveManualRule: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
};

const CATEGORIES = [
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null },
];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 20, matched: 12, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 12 },
  byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: 12, samples: ['COLES 1234 RICHMOND'] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 12, createdRule: null,
  ...over,
});

async function mountConfirm(budgetExcluded: boolean, pattern = 'COLES', categoryId = 'groceries') {
  mockState = {
    sheet: { mode: 'addRuleConfirm', pattern, categoryId, budgetExcluded },
    toast: null, categories: CATEGORIES, ...fns,
  } as unknown as AppContext;
  render(<Overlays />);
  await act(async () => {}); // let the mount-time preview resolve
}

beforeEach(() => { jest.clearAllMocks(); });

it('previews (dry-run) with budgetExcluded:true from the sheet payload', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report() });
  await mountConfirm(true);
  expect(fns.previewFiling).toHaveBeenCalledWith({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: true });
});

it('"Add rule + file N" commits via fileNewRule with budgetExcluded:true', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report() });
  fns.fileCharges.mockResolvedValue({ status: 'filed', report: report({ dryRun: false, matched: 12, filed: [{ id: 't0', category: 'groceries' }] }) });
  await mountConfirm(true);
  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  expect(fns.fileCharges).toHaveBeenCalledWith({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: true }, { now: true });
});

it('"Add rule only" saves via saveManualRule with budgetExcluded:true', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report() });
  await mountConfirm(true);
  fireEvent.press(screen.getByTestId('add-rule-confirm-rule-only'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'groceries', true);
});
