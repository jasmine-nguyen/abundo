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
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, FilingResult, FilingTarget, FilingWhen } from '../context';
import { APPLY_RULES_MAX_WRITES } from '../context';
import { ApiError } from '../apiError';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP_RECORD } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';
import { previewReport as report } from './support/applyRulesReport';

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
  GROCERIES_TOP_RECORD,
  { id: 'fuel', name: 'Fuel', bucket: 'Living', icon: 'car', parent: null },
];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mountConfirm(pattern = 'COLES', categoryId = 'groceries', budgetExcluded?: boolean) {
  server.seed('/categories', CATEGORIES);
  const state = { sheet: { mode: 'addRuleConfirm', pattern, categoryId, budgetExcluded }, toast: null, ...fns } as unknown as AppContext;
  const utils = await openOverlays(state, (next) => { mockState = next; });
  await act(async () => {}); // let the mount-time preview resolve
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

it('previews on mount and shows the matched count with sample descriptions', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  await mountConfirm('COLES', 'groceries', true);

  expect(fns.previewFiling).toHaveBeenCalledWith({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: true });
  expect(screen.getByTestId('add-rule-confirm-file')).toBeTruthy();
  expect(screen.getByText('Add rule + file 12 charges')).toBeTruthy();
});

// The load-bearing action: "Add rule + file N" must mint-and-file via fileNewRule with the captured
// pair, then toast + close. Fail-on-revert: wire it to saveManualRule and this reddens.
it('"Add rule + file N" calls fileNewRule with the captured pair, then toasts and closes', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  fns.fileCharges.mockResolvedValue({ status: 'filed', report: report({ dryRun: false, matched: 12, filed: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, category: 'groceries' })) }) });
  await mountConfirm('COLES', 'groceries', true);

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });

  expect(fns.fileCharges).toHaveBeenCalledWith({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: true }, { now: true });
  expect(fns.showToast).toHaveBeenCalledWith('Rule added — filed 12 past charges as Groceries.');
  expect(fns.setSheet).toHaveBeenCalledWith(null);
});

// The future-only path: "Add rule only" saves the rule and files nothing. Fail-on-revert: wire it to
// fileNewRule and this reddens.
it('"Add rule only" calls saveManualRule and never files', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  await mountConfirm('COLES', 'groceries', true);

  fireEvent.press(screen.getByTestId('add-rule-confirm-rule-only'));

  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'groceries', true);
  expect(fns.fileCharges).not.toHaveBeenCalled();
});

// Nothing to file: offer only "Add rule" (future-only), never a no-op "+ file 0".
// Fail-on-revert: drop the matched===0 arm and the "+ file" button shows.
it('says nothing matches and offers no "+ file" button when matched is 0', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 0, byRule: [] }) });
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
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: over }) });
  await mountConfirm();

  expect(screen.getByText(`Add rule + file up to ${APPLY_RULES_MAX_WRITES}`)).toBeTruthy();
  expect(screen.queryByText(`Add rule + file ${over} charges`)).toBeNull();
});

// A clash surfaced by the preview (a rule the client didn't know about already files this pattern):
// show the clash card, no file button. Fail-on-revert: collapse the clash outcome and the file button returns.
it('shows the clash card and no file button when the preview reports a clash', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'clash', error: new ApiError(409, null), background: false });
  await mountConfirm();

  expect(screen.getByText('You already have a rule for this')).toBeTruthy();
  expect(screen.queryByTestId('add-rule-confirm-file')).toBeNull();
});

// "Add rule only" is a mint with no latch of its own, so it must be guarded against a same-frame
// double-tap or it would mint two rules. Fail-on-revert: drop the runGuarded wrapper on onRuleOnly
// and the second press fires a second saveManualRule.
it('double-tapping "Add rule only" calls saveManualRule exactly once', async () => {
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 12 }) });
  fns.saveManualRule.mockReturnValue(new Promise(() => {})); // never resolves → latch stays held
  await mountConfirm('COLES', 'groceries');

  await act(async () => {
    const btn = screen.getByTestId('add-rule-confirm-rule-only');
    fireEvent.press(btn);
    fireEvent.press(btn); // same frame
  });
  expect(fns.saveManualRule).toHaveBeenCalledTimes(1);
});

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

// [A35]/[A36] A failure or 409-clash settling after the sheet was dismissed must still toast the
// outcome, never drop it. Fail-on-revert: drop either off-screen `else showToast(...)` and its row reddens.
it.each([
  ['[A35] dismissed mid-write: non-clash failure toasts off screen', { status: 'failed', background: false } as FilingResult],
  ['[A36] dismissed mid-write: 409-clash toasts off screen', { status: 'clash', error: new ApiError(409, null), background: false } as FilingResult],
])('%s', async (_name, outcome) => {
  const pending = deferred<FilingResult>();
  fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
  fns.fileCharges.mockReturnValue(pending.promise);
  const { rerender } = await mountConfirm('COLES', 'groceries');

  await act(async () => { fireEvent.press(screen.getByTestId('add-rule-confirm-file')); });
  mockState = { ...mockState, sheet: null } as unknown as AppContext;
  await act(async () => { rerender(overlaysTree()); });
  expect(fns.showToast).not.toHaveBeenCalled();

  await act(async () => { pending.resolve(outcome); });

  expect(fns.showToast).toHaveBeenCalledTimes(1);
});

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

// [A6] add-rule confirm for a category the server no longer has: nothing drawn, nothing previewed.
it('[A6] add-rule confirm for a category missing on the server draws nothing and never previews', async () => {
  await mountConfirm('COLES', 'deleted-cat');

  expect(fns.previewFiling).not.toHaveBeenCalled();
  expect(screen.queryByTestId('add-rule-confirm-file-all')).toBeNull();
  expect(screen.queryByTestId('add-rule-confirm-apply')).toBeNull();
});
