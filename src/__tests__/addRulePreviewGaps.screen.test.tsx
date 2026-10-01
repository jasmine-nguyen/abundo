// WHIT-538 — GAP tests for AddRuleConfirmSheet, adversarial to addRulePreview.screen.test.tsx.
// The implementer covered: preview-on-mount count+samples, "Add rule + file N" happy path, "Add
// rule only", matched===0, capped label, preview-clash card. NOT covered and pinned here:
//   - [A30] "Back" returns to the add-rule form (setSheet {mode:'addrule'}) from the preview card
//   - [A31] the previewFailed card + "Try again" re-runs a FRESH preview into the preview card
//   - [A32] a WRITE that fails non-clash while on screen → the "Couldn't finish" (writeFailed) card
//   - [A33] a WRITE 409-clash while on screen → the clash card (distinct from the preview clash)
//   - [A34] dismissed mid-write, success settles off screen → toast + does NOT setSheet(null)
//   - [A35] dismissed mid-write, non-clash failure settles off screen → the off-screen else-toast
//   - [A36] dismissed mid-write, 409-clash settles off screen → the off-screen clash toast
//   - [A37] capped success toast wording: "More to go — use "Apply my rules" to finish."
//   - [A38] a success that filed ZERO rows → the "Rule added — it files as X." copy
//   - [A39] double-tap the file button → fileNewRule fires exactly once (useInFlightGuard)
//   - [A40] null sample descriptions from byRule[0].samples are filtered out, not rendered blank
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, FilingResult, FilingTarget, FilingWhen } from '../context';
import type { ApplyRulesResult } from '../api';
import { APPLY_RULES_MAX_WRITES } from '../context';
import { ApiError } from '../apiError';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  saveManualRule: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
};

const CATEGORIES = [
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', parent: null },
];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 20, matched: 12, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 12 },
  byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: 12, samples: ['COLES 1234 RICHMOND', 'COLES 5678 CBD'] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 12, createdRule: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mountConfirm(pattern = 'COLES', categoryId = 'groceries') {
  server.seed('/categories', CATEGORIES);
  const state = { sheet: { mode: 'addRuleConfirm', pattern, categoryId }, toast: null, ...fns } as unknown as AppContext;
  const utils = await openOverlays(state, (next) => { mockState = next; });
  await act(async () => {}); // let the mount-time preview resolve
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// --- Back navigation ----------------------------------------------------------

// [A30] "Back" from the preview card returns to the add-rule form so the draft (which survives a
// non-null sheet transition) can be edited. Fail-on-revert: point goBack at setSheet(null) and the
// {mode:'addrule'} assertion reddens.
it('[A30] "Back" returns to the add-rule form', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  await mountConfirm('COLES', 'groceries');

  fireEvent.press(screen.getByTestId('add-rule-confirm-back'));
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addrule' });
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);
});

// --- previewFailed + retry ----------------------------------------------------

// [A31] A preview that fails for a NON-clash reason shows the retry card, and "Try again" fires a
// FRESH preview that can succeed into the preview card. Fail-on-revert: drop the previewFailed arm
// and the busy spinner never resolves here; drop the retry wiring and the second preview never fires.
it('[A31] shows the preview-failed card and retries into a fresh preview', async () => {
  fns.previewFiling
    .mockResolvedValueOnce({ status: 'failed', background: false })
    .mockResolvedValueOnce({ status: 'filed', report: report({ matched: 12 }) });
  await mountConfirm();

  expect(screen.getByText("Couldn't check this rule")).toBeTruthy();
  expect(screen.queryByTestId('add-rule-confirm-file')).toBeNull();

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-retry')); });
  expect(fns.previewFiling).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('add-rule-confirm-file')).toBeTruthy();
});

// --- write failure arms (on screen) -------------------------------------------

// [A32] A WRITE that fails non-clash (unknown outcome) while on screen shows the "Couldn't finish"
// card — NOT the clash card, NOT a success close. Fail-on-revert: drop the writeFailed arm and the
// sheet is stuck on the "Adding your rule…" spinner.
it('[A32] shows the "Couldn\'t finish" card when the write fails non-clash', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  fns.fileCharges.mockResolvedValue({ status: 'failed', background: false });
  await mountConfirm();

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  expect(screen.getByText("Couldn't finish")).toBeTruthy();
  expect(screen.queryByText('You already have a rule for this')).toBeNull();
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);
});

// [A33] A WRITE that 409-clashes while on screen shows the clash card (a rule was created elsewhere
// between preview and write). Distinct from [A32]'s writeFailed and from the implementer's PREVIEW
// clash. Fail-on-revert: collapse the write clash into writeFailed and the clash title reddens.
it('[A33] shows the clash card when the write reports a 409 clash', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  fns.fileCharges.mockResolvedValue({ status: 'clash', error: new ApiError(409, null), background: false });
  await mountConfirm();

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  expect(screen.getByText('You already have a rule for this')).toBeTruthy();
  expect(screen.queryByText("Couldn't finish")).toBeNull();
});

// --- dismissed mid-write (onScreen ref) ---------------------------------------

// [A34] The sheet is dismissable while the write is in flight. A SUCCESS settling off screen must
// still toast, but must NOT setSheet(null) against a dismissed sheet. Fail-on-revert: remove the
// `if (onScreen.current)` guard on the success close and setSheet(null) fires.
it('[A34] dismissed mid-write: success toasts but does not setSheet(null)', async () => {
  const pending = deferred<FilingResult>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockReturnValue(pending.promise);
  const { rerender } = await mountConfirm();

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  mockState = { ...mockState, sheet: null } as unknown as AppContext;
  await act(async () => { rerender(overlaysTree()); });

  await act(async () => { pending.resolve({ status: 'filed', report: report({ dryRun: false, matched: 2, filed: [{ id: 't1', category: 'groceries' }, { id: 't2', category: 'groceries' }] }) }); });

  expect(fns.showToast).toHaveBeenCalledWith('Rule added — filed 2 past charges as Groceries.');
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);
});

// [A35] A non-clash FAILURE settling off screen must TOAST the outcome (not drop it) — the off-screen
// else-branch [A34] can't reach (its success toast fires before the guard). Fail-on-revert: drop the
// `else showToast(...)` on the writeFailed path and the outcome vanishes with no toast.
it('[A35] dismissed mid-write: non-clash failure toasts off screen', async () => {
  const pending = deferred<FilingResult>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockReturnValue(pending.promise);
  const { rerender } = await mountConfirm('COLES', 'groceries');

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  mockState = { ...mockState, sheet: null } as unknown as AppContext;
  await act(async () => { rerender(overlaysTree()); });

  await act(async () => { pending.resolve({ status: 'failed', background: false }); });

  expect(fns.showToast).toHaveBeenCalledWith('Couldn\'t add the rule for “COLES”. Some charges may already have been filed.');
});

// [A36] A 409-clash settling off screen uses the off-screen clash toast, distinct from [A35]'s
// generic-failure toast. Fail-on-revert: drop the `else showToast(...)` on the clash path and a
// clash that lands off screen is dropped silently.
it('[A36] dismissed mid-write: 409-clash toasts off screen', async () => {
  const pending = deferred<FilingResult>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockReturnValue(pending.promise);
  const { rerender } = await mountConfirm('COLES', 'groceries');

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  mockState = { ...mockState, sheet: null } as unknown as AppContext;
  await act(async () => { rerender(overlaysTree()); });

  await act(async () => { pending.resolve({ status: 'clash', error: new ApiError(409, null), background: false }); });

  expect(fns.showToast).toHaveBeenCalledWith('You already have a rule for “COLES”.');
});

// --- success toast copy edges -------------------------------------------------

// [A37] A capped success (matched > write cap) leaves more to go, so the toast points at "Apply my
// rules" to finish the rest. Fail-on-revert: drop the `matched > cap` branch in addRuleFiledMessage
// and the toast reads a plain "…as Groceries." with no "More to go".
it('[A37] capped success toast points at "Apply my rules" to finish', async () => {
  const over = APPLY_RULES_MAX_WRITES + 50;
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: over }) });
  fns.fileCharges.mockResolvedValue({ status: 'filed', report: report({ dryRun: false, matched: over, filed: Array.from({ length: APPLY_RULES_MAX_WRITES }, (_, i) => ({ id: `t${i}`, category: 'groceries' })), remaining: 50 }) });
  await mountConfirm();

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  expect(fns.showToast).toHaveBeenCalledWith(`Rule added — filed ${APPLY_RULES_MAX_WRITES} past charges as Groceries. More to go — use “Apply my rules” to finish.`);
});

// [A38] A success that filed ZERO rows (the matched charges vanished between preview and write, but
// the rule was still minted) uses the "it files as X" copy — never "filed 0 past charges".
// Fail-on-revert: collapse the filed===0 branch in addRuleFiledMessage and this reddens.
it('[A38] success that filed zero rows uses the "it files as X" copy', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockResolvedValue({ status: 'filed', report: report({ dryRun: false, matched: 0, filed: [] }) });
  await mountConfirm();

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  expect(fns.showToast).toHaveBeenCalledWith('Rule added — it files as Groceries.');
  expect(fns.setSheet).toHaveBeenCalledWith(null);
});

// --- double-tap protection ----------------------------------------------------

// [A39] The file button is a mint+file write; a same-frame double-tap must fire fileNewRule exactly
// once (useInFlightGuard's synchronous latch). Fail-on-revert: drop the runGuarded wrapper on onFile
// and the second press fires a second fileNewRule → a duplicate mint+file.
it('[A39] double-tapping the file button fires fileNewRule exactly once', async () => {
  const pending = deferred<FilingResult>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockReturnValue(pending.promise);
  await mountConfirm();

  await act(async () => {
    const btn = screen.getByTestId('add-rule-confirm-file');
    fireEvent.press(btn);
    fireEvent.press(btn); // same frame, before the disabled state / phase flip lands
  });
  expect(fns.fileCharges).toHaveBeenCalledTimes(1);

  await act(async () => { pending.resolve({ status: 'filed', report: report({ dryRun: false, matched: 2, filed: [{ id: 't1', category: 'groceries' }, { id: 't2', category: 'groceries' }] }) }); });
});

// --- sample rendering edge -----------------------------------------------------

// [A40] Null description samples from byRule[0].samples are filtered out — the samples box renders
// only real strings, never a blank row. Fail-on-revert: drop the `.filter((s): s is string => !!s)`
// and the null renders as an empty <Text> row (and could crash numberOfLines on non-strings).
it('[A40] filters out null sample descriptions', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({
    matched: 3,
    byRule: [{ ruleId: null, value: 'coles', categoryId: 'groceries', count: 3, samples: ['COLES RICHMOND', null as unknown as string, 'COLES CBD'] }],
  }) });
  await mountConfirm();

  const box = screen.getByTestId('add-rule-confirm-samples');
  // Only the two non-null samples render as children.
  expect(box.children).toHaveLength(2);
  expect(screen.getByText('COLES RICHMOND')).toBeTruthy();
  expect(screen.getByText('COLES CBD')).toBeTruthy();
});

// --- cross-action double-tap (WHIT-557 shared commit latch) --------------------

// [A41] "File" and "rule only" share ONE commit latch (the shell's runGuarded). A same-frame double-
// tap across the TWO different buttons must fire exactly one write — never both. [A39] only covers
// the same button. Fail-on-revert: give the rule-only action its OWN useInFlightGuard (a separate
// latch) and both fire → a rule minted twice.
it('[A41] a cross-action double-tap (file then rule-only) fires exactly one write', async () => {
  const pending = deferred<FilingResult>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockReturnValue(pending.promise); // holds the shared latch
  await mountConfirm();

  await act(async () => {
    fireEvent.press(screen.getByTestId('add-rule-confirm-file'));
    fireEvent.press(screen.getByTestId('add-rule-confirm-rule-only')); // same frame — latch held
  });
  expect(fns.fileCharges).toHaveBeenCalledTimes(1);
  expect(fns.saveManualRule).toHaveBeenCalledTimes(0);

  await act(async () => { pending.resolve({ status: 'filed', report: report({ dryRun: false, matched: 2, filed: [{ id: 't1', category: 'groceries' }, { id: 't2', category: 'groceries' }] }) }); });
});

// [A42] The same guarantee the other way round: rule-only first holds the latch, so a following File
// tap in the same frame is swallowed. Fail-on-revert: same as [A41].
it('[A42] a cross-action double-tap (rule-only then file) fires exactly one write', async () => {
  const pending = deferred<void>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.saveManualRule.mockReturnValue(pending.promise); // holds the shared latch
  await mountConfirm();

  await act(async () => {
    fireEvent.press(screen.getByTestId('add-rule-confirm-rule-only'));
    fireEvent.press(screen.getByTestId('add-rule-confirm-file')); // same frame — latch held
  });
  expect(fns.saveManualRule).toHaveBeenCalledTimes(1);
  expect(fns.fileCharges).toHaveBeenCalledTimes(0);

  await act(async () => { pending.resolve(); });
});
