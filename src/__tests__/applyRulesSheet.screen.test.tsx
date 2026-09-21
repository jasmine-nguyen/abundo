// WHIT-508 — the "Apply my rules" sheet.
//
// This sheet's whole job is to be HONEST before it writes, so most of what is pinned here is copy
// under a specific server response:
//   - with no rules at all the server returns BEFORE scanning history, so `unfiled` is 0 — the
//     sheet must not read that as "you have nothing to file" while 639 charges sit behind it.
//   - the server writes at most APPLY_RULES_MAX_WRITES per call, so a big plan must say so BEFORE
//     the tap, not discover it afterwards.
//   - `remaining` equals `matched` in a PREVIEW, so the partial state can only key on a real write.
//   - `failed` rows sit outside `remaining` but are still unfiled, so "still to go" is the sum.
//   - a rule filing to Income has no row in the taxonomy map and must not render a blank name.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext, ApplyRulesResult } from '../context';

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
};

const CATEGORIES = [{ id: 'groceries', name: 'Groceries' }, { id: 'fuel', name: 'Fuel' }];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 2, unfiled: 10, matched: 4, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 4 },
  byRule: [{ ruleId: 'r1', value: 'coles', categoryId: 'groceries', count: 4, samples: ['COLES 1234 RICHMOND'] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 4,
  ...over,
});

function mount() {
  mockState = { sheet: { mode: 'applyRules' }, toast: null, categories: CATEGORIES, ...fns } as unknown as AppContext;
  return render(<Overlays />);
}

/** Mount and let the mount-time preview resolve. */
async function mountWithPreview(preview: ApplyRulesResult | null) {
  fns.previewRuleApplication.mockResolvedValue(preview);
  mount();
  await act(async () => {});
  return screen;
}

/** A promise the test resolves itself, so two requests can genuinely overlap. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { jest.clearAllMocks(); });

// --- loading ------------------------------------------------------------------

it('previews once on mount and shows the checking copy while it runs', async () => {
  fns.previewRuleApplication.mockReturnValue(new Promise(() => {}));  // never settles
  mount();

  expect(screen.getByTestId('apply-rules-busy')).toBeTruthy();
  expect(screen.getByText('Checking what your rules would file…')).toBeTruthy();
  expect(fns.previewRuleApplication).toHaveBeenCalledTimes(1);
  // Fail-on-revert for the dry run: the preview must never reach the writer.
  expect(fns.applyRulesToHistory).not.toHaveBeenCalled();
});

// --- no rules vs nothing matched (two DIFFERENT states) -----------------------

// The trap: with zero rules the server returns before the history scan, so unfiled is 0. Copy
// keyed only on `matched === 0` would claim she has no unfiled charges while the tab shows 639.
it('says "no rules yet" when the user has none — never "0 unfiled charges"', async () => {
  await mountWithPreview(report({ rulesConsidered: 0, unfiled: 0, matched: 0, byRule: [], remaining: 0 }));

  expect(screen.getByText("You don't have any rules yet")).toBeTruthy();
  expect(screen.queryByText(/0 unfiled/)).toBeNull();
  expect(screen.queryByTestId('apply-rules-apply')).toBeNull();   // nothing to apply
});

it('says the rules match nothing when there are rules but no hits', async () => {
  await mountWithPreview(report({ rulesConsidered: 2, unfiled: 10, matched: 0, byRule: [], remaining: 0 }));

  expect(screen.getByText('Nothing to file automatically')).toBeTruthy();
  expect(screen.getByText('None of your 2 rules match your 10 unfiled charges.')).toBeTruthy();
  expect(screen.queryByTestId('apply-rules-apply')).toBeNull();
});

// `matched === 0` does NOT mean the rules missed: rule_engine counts a rule's hits BEFORE the
// conflict check, so two rules that disagree on every charge they cover give matched 0 with a
// non-empty breakdown. The old copy claimed "none of your rules match" directly above a list
// showing them matching. Fail-on-revert: restore that sentence and this reddens.
it('does not claim the rules missed when they actually disagreed', async () => {
  await mountWithPreview(report({
    rulesConsidered: 2, unfiled: 10, matched: 0, conflicted: 5,
    conflictedSamples: [{ description: 'COLES EXPRESS', categoryIds: ['fuel', 'groceries'] }],
    byRule: [{ ruleId: 'r1', value: 'coles', categoryId: 'groceries', count: 5, samples: [] }],
    remaining: 0,
  }));

  expect(screen.getByText('Your rules disagree about every charge they cover, so none were filed.')).toBeTruthy();
  expect(screen.queryByText(/match your 10 unfiled/)).toBeNull();
  expect(screen.getByText('"coles" → Groceries · 5 charges')).toBeTruthy();  // the breakdown agrees
});

// The other route to matched 0: every rule was SKIPPED, so none was ever evaluated. Saying they
// "don't match" would be inventing a reason the report doesn't support.
it('says the rules could not be applied when every one was skipped', async () => {
  await mountWithPreview(report({
    rulesConsidered: 2, unfiled: 10, matched: 0, byRule: [], remaining: 0,
    skippedRules: [
      { id: 'r1', value: 'uber', reason: 'rule has more than one condition' },
      { id: 'r2', value: 'aldi', reason: 'category no longer exists' },
    ],
  }));

  expect(screen.getByText('None of your 2 rules can be applied — see why below.')).toBeTruthy();
  expect(screen.queryByText(/match your 10 unfiled/)).toBeNull();
});

// --- the preview --------------------------------------------------------------

it('shows the per-rule breakdown with the category NAME and sample descriptions', async () => {
  await mountWithPreview(report({
    byRule: [{ ruleId: 'r1', value: 'aldi', categoryId: 'groceries', count: 40, samples: ['VIVALDI CAFE', 'ALDI 220'] }],
    matched: 40,
  }));

  expect(screen.getByText('"aldi" → Groceries · 40 charges')).toBeTruthy();
  // The over-eager-rule signal: the sample makes "ALDI also catches VIVALDI" visible BEFORE the write.
  expect(screen.getByText('VIVALDI CAFE')).toBeTruthy();
});

// A rule filing to Income is applicable server-side (income counts as filed) but has no row in
// the taxonomy map, so a bare lookup renders nothing under the count.
it('renders an income rule as "Income" and an unknown id as itself', async () => {
  await mountWithPreview(report({
    byRule: [
      { ruleId: 'r1', value: 'salary', categoryId: 'income', count: 2, samples: [] },
      { ruleId: 'r2', value: 'misc', categoryId: 'deleted-cat', count: 1, samples: [] },
    ],
  }));

  expect(screen.getByText('"salary" → Income · 2 charges')).toBeTruthy();
  expect(screen.getByText('"misc" → deleted-cat · 1 charge')).toBeTruthy();
});

it('shows conflicts with their samples and the disagreeing category names', async () => {
  await mountWithPreview(report({
    conflicted: 3,
    conflictedSamples: [{ description: 'COLES EXPRESS', categoryIds: ['fuel', 'groceries'] }],
  }));

  expect(screen.getByTestId('apply-rules-conflicts')).toBeTruthy();
  expect(screen.getByText('3 charges match two rules that disagree, so they\'re left alone.')).toBeTruthy();
  expect(screen.getByText('COLES EXPRESS — Fuel vs Groceries')).toBeTruthy();
});

// The reasons are authored server-side and already plain English, so they render verbatim — a
// client re-wording map would drift from shared/rule_engine.py with nothing to catch it.
it('lists skipped rules with the server reason verbatim', async () => {
  await mountWithPreview(report({
    skippedRules: [{ id: 'r9', value: 'uber', reason: 'rule has more than one condition' }],
  }));

  expect(screen.getByText('1 rule skipped')).toBeTruthy();
  expect(screen.getByText('"uber" — rule has more than one condition')).toBeTruthy();
});

// --- the cap ------------------------------------------------------------------

// WHIT-560: over the per-run cap, the uncapped background sweep is the PRIMARY action ("Apply to
// all history") and the one-round instant file is demoted to a secondary "File up to 300 now".
// Fail-on-revert: render `File {matched} charges` unconditionally and all three assertions redden.
it('offers the uncapped background sweep before the tap when the plan is bigger than the per-run cap', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));

  expect(screen.getByText(/Filing them all runs in the background/)).toBeTruthy();
  expect(screen.getByTestId('apply-rules-apply-all')).toBeTruthy();
  expect(screen.getByText('Apply to all history')).toBeTruthy();
  expect(screen.getByText('File up to 300 now')).toBeTruthy();
});

it('promises the exact number when the plan fits in one run', async () => {
  await mountWithPreview(report({ unfiled: 10, matched: 4 }));

  expect(screen.getByText('File 4 charges')).toBeTruthy();
  expect(screen.queryByText(/up to 300/)).toBeNull();
});

// --- applying -----------------------------------------------------------------

it('files on tap, then closes and toasts on a clean run', async () => {
  await mountWithPreview(report({ matched: 4 }));
  fns.applyRulesToHistory.mockResolvedValue(report({
    dryRun: false, matched: 4, filed: [1, 2, 3, 4].map((n) => ({ id: `t${n}`, category: 'groceries' })), remaining: 0,
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(fns.applyRulesToHistory).toHaveBeenCalledTimes(1);
  expect(fns.setSheet).toHaveBeenCalledWith(null);
  expect(fns.showToast).toHaveBeenCalledWith('Filed 4 charges with your rules.');
});

// The useInFlightGuard latch flips BEFORE the first await, so two taps in one frame — before
// React redraws the button into its busy state — still file once.
it('files once on a same-frame double tap', async () => {
  await mountWithPreview(report({ matched: 4 }));
  fns.applyRulesToHistory.mockResolvedValue(report({ dryRun: false, filed: [{ id: 't1', category: 'groceries' }], remaining: 0 }));

  const button = screen.getByTestId('apply-rules-apply');
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });

  expect(fns.applyRulesToHistory).toHaveBeenCalledTimes(1);
});

it('cancel closes the sheet and writes nothing', async () => {
  await mountWithPreview(report());

  fireEvent.press(screen.getByTestId('apply-rules-cancel'));

  expect(fns.setSheet).toHaveBeenCalledWith(null);
  expect(fns.applyRulesToHistory).not.toHaveBeenCalled();
});

// --- after a partial run ------------------------------------------------------

// `remaining` counts rows never attempted; `failed` rows WERE attempted and are excluded from it,
// yet they are still unfiled. Offering only `remaining` would strand them.
it('keeps the sheet open with the work left, counting failed rows too', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));
  fns.applyRulesToHistory.mockResolvedValue(report({
    dryRun: false, matched: 512, remaining: 200, failed: ['t9', 't10'],
    filed: Array.from({ length: 298 }, (_, n) => ({ id: `t${n}`, category: 'groceries' })),
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText(/202 still to go/)).toBeTruthy();
  expect(screen.getByText(/2 we couldn't save/)).toBeTruthy();
  expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);   // stays open for the next round
  expect(fns.showToast).not.toHaveBeenCalled();          // the sheet says it; a toast would repeat it
});

// The cap is only one of three reasons a run stops — the server also has a wall-clock budget, and
// rows can be left over because they ERRORED. Blaming the cap for a run that attempted 3 rows is a
// made-up explanation. Fail-on-revert: print the cap line unconditionally and this reddens.
it('only blames the 300 cap when the run actually reached it', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));
  fns.applyRulesToHistory.mockResolvedValue(report({
    dryRun: false, matched: 512, filed: [{ id: 't1', category: 'groceries' }], remaining: 12,
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText('12 still to go.')).toBeTruthy();
  expect(screen.queryByText(/up to 300 at a time/)).toBeNull();
});

// WHIT-508. A charge the user filed mid-run was attempted too, so it consumed a slot of the cap.
// Leaving it out would under-count and drop the "we file up to 300 at a time" explanation from a
// run that genuinely hit the cap. Fail-on-revert: remove alreadyFiled from `attempted` → red.
it('counts rows the user filed mid-run toward the per-run cap', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));
  fns.applyRulesToHistory.mockResolvedValue(report({
    dryRun: false, matched: 512, remaining: 212,
    filed: Array.from({ length: 250 }, (_, n) => ({ id: `f${n}`, category: 'groceries' })),
    alreadyFiled: Array.from({ length: 50 }, (_, n) => `a${n}`),
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText(/we file up to 300 at a time/)).toBeTruthy();
  // And SAY why the round skipped them, or it reads as "Couldn't file any this time" with no
  // explanation. A separate sentence on purpose: the failed count is INSIDE "still to go" and
  // this one is outside it. Fail-on-revert: delete the line from the sheet and this reddens —
  // nothing else does, because both branches are already executed by other tests.
  expect(screen.getByText(/You'd already filed 50 charges yourself\./)).toBeTruthy();
});

// The two parentheticals mean opposite things — `failed` rows are counted in "still to go",
// already-filed ones are not — so they must never read as one undifferentiated list.
it('separates what is still to do from what someone else already did', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));
  fns.applyRulesToHistory.mockResolvedValue(report({
    dryRun: false, matched: 512, remaining: 212, failed: ['x', 'y', 'z'],
    filed: [{ id: 't1', category: 'groceries' }], alreadyFiled: ['a1'],
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText(/215 still to go \(3 we couldn't save\)/)).toBeTruthy();
  expect(screen.getByText(/You'd already filed 1 charge yourself\./)).toBeTruthy();
});

// The app ships through the store and the server through its own deploy, so a released app can
// meet a server that predates this field. Reading it blindly would throw mid-render on every run.
it('renders a write result from a server that does not send alreadyFiled', async () => {
  await mountWithPreview(report({ matched: 4 }));
  const withoutField = report({ dryRun: false, matched: 4, remaining: 2, filed: [] });
  delete (withoutField as { alreadyFiled?: string[] }).alreadyFiled;
  fns.applyRulesToHistory.mockResolvedValue(withoutField);

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText(/2 still to go/)).toBeTruthy();
});

// A round where every write errored saved nothing. "Filed 0 charges" reads as success.
it('does not report a filing when the round saved nothing', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));
  fns.applyRulesToHistory.mockResolvedValue(report({
    dryRun: false, matched: 512, filed: [], failed: ['t1', 't2'], remaining: 300,
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText("Couldn't file any this time")).toBeTruthy();
  expect(screen.queryByText(/Filed 0/)).toBeNull();
});

// Each round's report describes only ITS round, so reading the total off the last one would
// announce "Filed 39" after filing 639. Fail-on-revert: toast result.filed.length and this reddens.
it('counts the whole job across rounds, not just the last one', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 639, remaining: 639 }));
  const round = (filed: number, remaining: number) => report({
    dryRun: false, matched: 639, remaining,
    filed: Array.from({ length: filed }, (_, n) => ({ id: `r${remaining}-${n}`, category: 'groceries' })),
  });

  fns.applyRulesToHistory.mockResolvedValueOnce(round(300, 339));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });
  expect(screen.getByText('Filed 300 charges so far')).toBeTruthy();

  fns.applyRulesToHistory.mockResolvedValueOnce(round(300, 39));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });
  expect(screen.getByText('Filed 600 charges so far')).toBeTruthy();

  fns.applyRulesToHistory.mockResolvedValueOnce(round(39, 0));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });
  expect(fns.showToast).toHaveBeenCalledWith('Filed 639 charges with your rules.');
});

// A PREVIEW sets remaining = matched, so a partial state keyed on `remaining > 0` would fire on
// every preview and offer "Apply the rest" before anything had been applied.
it('never shows the partial state for a preview whose remaining equals matched', async () => {
  await mountWithPreview(report({ dryRun: true, matched: 4, remaining: 4 }));

  expect(screen.queryByTestId('apply-rules-continue')).toBeNull();
  expect(screen.getByTestId('apply-rules-apply')).toBeTruthy();
});

it('re-renders from the write response, not the stale preview', async () => {
  await mountWithPreview(report({ matched: 512, unfiled: 639, remaining: 512 }));
  // A category was deleted between the preview and the write, so the server re-planned smaller.
  fns.applyRulesToHistory.mockResolvedValue(report({
    dryRun: false, matched: 50, filed: [{ id: 't1', category: 'groceries' }], remaining: 12,
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText('Filed 1 charge so far')).toBeTruthy();
  // 12 left, from the write's re-plan — not the preview's 512.
  expect(screen.getByText('12 still to go.')).toBeTruthy();
});

it('reports nothing left when a re-run files zero', async () => {
  await mountWithPreview(report({ matched: 4 }));
  fns.applyRulesToHistory.mockResolvedValue(report({ dryRun: false, filed: [], remaining: 0 }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(fns.showToast).toHaveBeenCalledWith('Nothing left for your rules to file.');
});

// --- failures -----------------------------------------------------------------

it('offers a retry when the preview fails, and the retry re-previews', async () => {
  await mountWithPreview(null);

  expect(screen.getByText("Couldn't read your rules")).toBeTruthy();
  expect(screen.getByText('Nothing has been changed. Please try again.')).toBeTruthy();

  fns.previewRuleApplication.mockResolvedValue(report({ matched: 4 }));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-retry')); });

  expect(fns.previewRuleApplication).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('apply-rules-apply')).toBeTruthy();
});

// A preview is a whole-history scan plus a live rules read. Two in flight cost double the server
// work and can resolve out of order, painting the older answer over the newer — so the retry shares
// the mount call's latch. Fail-on-revert: call runPreview unguarded and the second scan starts.
it('runs one preview even when Try again is double-tapped', async () => {
  await mountWithPreview(null);   // first attempt fails → the retry button is on screen
  expect(fns.previewRuleApplication).toHaveBeenCalledTimes(1);

  const pending = deferred<ApplyRulesResult | null>();
  fns.previewRuleApplication.mockReturnValue(pending.promise);
  const retry = screen.getByTestId('apply-rules-retry');
  await act(async () => { fireEvent.press(retry); fireEvent.press(retry); });

  expect(fns.previewRuleApplication).toHaveBeenCalledTimes(2);   // one retry, not two

  await act(async () => { pending.resolve(report({ matched: 4 })); });
  expect(screen.getByText('File 4 charges')).toBeTruthy();
});

// The blocker: the server commits row by row, so an abort mid-write can leave charges filed. The
// copy must not claim nothing happened, and must not tell her to pull to refresh — the context
// action already refreshed the caches for her.
it('says the outcome is uncertain when the write fails', async () => {
  await mountWithPreview(report({ matched: 4 }));
  fns.applyRulesToHistory.mockResolvedValue(null);

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText("Couldn't finish")).toBeTruthy();
  expect(screen.getByText(/Some charges may already have been filed/)).toBeTruthy();
  expect(screen.queryByText(/pull down/i)).toBeNull();
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);  // she reads it before it closes
});
