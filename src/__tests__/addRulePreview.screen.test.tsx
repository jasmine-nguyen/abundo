// WHIT-538 — the AddRuleConfirmSheet: the preview-before-save step for a NEW rule.
//
// Flow: type a rule in the add-rule sheet → this confirm sheet previews (dry run) how many stored
// charges the pattern would file → "Add rule + file N" mints the rule AND files them, or "Add rule
// only" saves the rule for future charges. What carries real risk and is pinned here (the
// implementer's happy-path + acceptance half; qa owns the adversarial gaps):
//   - the sheet previews on mount and shows the matched count + a few sample descriptions;
//   - "Add rule + file N" calls fileNewRule with the captured (pattern, categoryId), toasts, closes;
//   - "Add rule only" calls saveManualRule (the future-only path);
//   - matched 0 → "No past charges match", no "+ file" button;
//   - a shop bigger than the write cap shows "up to N", not the full count;
//   - a 409 clash surfaced by the preview shows the clash card and no file button.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, FileByShopOutcome } from '../context';
import type { ApplyRulesResult } from '../api';
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
  saveManualRule: jest.fn(),
  previewNewRule: jest.fn<(pattern: string, categoryId: string) => Promise<FileByShopOutcome>>(),
  fileNewRule: jest.fn<(pattern: string, categoryId: string) => Promise<FileByShopOutcome>>(),
};

const CATEGORIES = [
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null },
  { id: 'fuel', name: 'Fuel', bucket: 'Living', icon: 'car', color: '#F2C94C', parent: null },
];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 20, matched: 12, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 12 },
  byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: 12, samples: ['COLES 1234 RICHMOND', 'COLES 5678 CBD'] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 12, createdRule: null,
  ...over,
});

async function mountConfirm(pattern = 'COLES', categoryId = 'groceries') {
  mockState = {
    sheet: { mode: 'addRuleConfirm', pattern, categoryId }, toast: null, categories: CATEGORIES, ...fns,
  } as unknown as AppContext;
  render(<Overlays />);
  await act(async () => {}); // let the mount-time preview resolve
}

beforeEach(() => { jest.clearAllMocks(); });

it('previews on mount and shows the matched count with sample descriptions', async () => {
  fns.previewNewRule.mockResolvedValue({ ok: true, report: report({ matched: 12 }) });
  await mountConfirm('COLES', 'groceries');

  expect(fns.previewNewRule).toHaveBeenCalledWith('COLES', 'groceries', false);
  expect(screen.getByTestId('add-rule-confirm-file')).toBeTruthy();
  expect(screen.getByText('Add rule + file 12 charges')).toBeTruthy();
  expect(screen.getByText('COLES 1234 RICHMOND')).toBeTruthy();
});

// The load-bearing action: "Add rule + file N" must mint-and-file via fileNewRule with the captured
// pair, then toast + close. Fail-on-revert: wire it to saveManualRule and this reddens.
it('"Add rule + file N" calls fileNewRule with the captured pair, then toasts and closes', async () => {
  fns.previewNewRule.mockResolvedValue({ ok: true, report: report({ matched: 12 }) });
  fns.fileNewRule.mockResolvedValue({ ok: true, report: report({ dryRun: false, matched: 12, filed: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, category: 'groceries' })) }) });
  await mountConfirm('COLES', 'groceries');

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });

  expect(fns.fileNewRule).toHaveBeenCalledWith('COLES', 'groceries', false);
  expect(fns.showToast).toHaveBeenCalledWith('Rule added — filed 12 past charges as Groceries.');
  expect(fns.setSheet).toHaveBeenCalledWith(null);
});

// The future-only path: "Add rule only" saves the rule and files nothing. Fail-on-revert: wire it to
// fileNewRule and this reddens.
it('"Add rule only" calls saveManualRule and never files', async () => {
  fns.previewNewRule.mockResolvedValue({ ok: true, report: report({ matched: 12 }) });
  await mountConfirm('COLES', 'groceries');

  fireEvent.press(screen.getByTestId('add-rule-confirm-rule-only'));

  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'groceries', false);
  expect(fns.fileNewRule).not.toHaveBeenCalled();
});

// Nothing to file: offer only "Add rule" (future-only), never a no-op "+ file 0".
// Fail-on-revert: drop the matched===0 arm and the "+ file" button shows.
it('says nothing matches and offers no "+ file" button when matched is 0', async () => {
  fns.previewNewRule.mockResolvedValue({ ok: true, report: report({ matched: 0, byRule: [] }) });
  await mountConfirm('ZZZNOPE', 'groceries');

  expect(screen.getByText('No past charges match')).toBeTruthy();
  expect(screen.queryByTestId('add-rule-confirm-file')).toBeNull();
  fireEvent.press(screen.getByTestId('add-rule-confirm-rule-only'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('ZZZNOPE', 'groceries', false);
});

// A match bigger than the write cap can't file in one tap, so the button must not promise the full
// count. Fail-on-revert: drop the `capped` label and it reads the full count.
it('says "up to N" (not the full count) when the match exceeds the write cap', async () => {
  const over = APPLY_RULES_MAX_WRITES + 200;
  fns.previewNewRule.mockResolvedValue({ ok: true, report: report({ matched: over }) });
  await mountConfirm();

  expect(screen.getByText(`Add rule + file up to ${APPLY_RULES_MAX_WRITES}`)).toBeTruthy();
  expect(screen.queryByText(`Add rule + file ${over} charges`)).toBeNull();
});

// A clash surfaced by the preview (a rule the client didn't know about already files this pattern):
// show the clash card, no file button. Fail-on-revert: collapse the clash outcome and the file button returns.
it('shows the clash card and no file button when the preview reports a clash', async () => {
  fns.previewNewRule.mockResolvedValue({ ok: false, clash: new ApiError(409, null) });
  await mountConfirm();

  expect(screen.getByText('You already have a rule for this')).toBeTruthy();
  expect(screen.queryByTestId('add-rule-confirm-file')).toBeNull();
});

// "Add rule only" is a mint with no latch of its own, so it must be guarded against a same-frame
// double-tap or it would mint two rules. Fail-on-revert: drop the runGuarded wrapper on onRuleOnly
// and the second press fires a second saveManualRule.
it('double-tapping "Add rule only" calls saveManualRule exactly once', async () => {
  fns.previewNewRule.mockResolvedValue({ ok: true, report: report({ matched: 12 }) });
  fns.saveManualRule.mockReturnValue(new Promise(() => {})); // never resolves → latch stays held
  await mountConfirm('COLES', 'groceries');

  await act(async () => {
    const btn = screen.getByTestId('add-rule-confirm-rule-only');
    fireEvent.press(btn);
    fireEvent.press(btn); // same frame
  });
  expect(fns.saveManualRule).toHaveBeenCalledTimes(1);
});
