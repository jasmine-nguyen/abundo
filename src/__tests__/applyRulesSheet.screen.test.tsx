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
  skippedRules: [], filed: [], vanished: [], failed: [], remaining: 4,
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

  expect(screen.getByText('Nothing to file')).toBeTruthy();
  expect(screen.getByText('None of your 2 rules match your 10 unfiled charges.')).toBeTruthy();
  expect(screen.queryByTestId('apply-rules-apply')).toBeNull();
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
// client re-wording map would drift from lambda_api/rule_apply.py with nothing to catch it.
it('lists skipped rules with the server reason verbatim', async () => {
  await mountWithPreview(report({
    skippedRules: [{ id: 'r9', value: 'uber', reason: 'rule has more than one condition' }],
  }));

  expect(screen.getByText('1 rule skipped')).toBeTruthy();
  expect(screen.getByText('"uber" — rule has more than one condition')).toBeTruthy();
});

// --- the cap ------------------------------------------------------------------

// The honesty fix: with 639 unfiled charges the FIRST run is guaranteed partial, so the button
// must not promise 512. Fail-on-revert: render `File {matched} charges` unconditionally and both
// assertions redden.
it('warns about the per-run cap before the tap when the plan is bigger than it', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));

  expect(screen.getByText(/We file up to 300 at a time, so this will take a few rounds\./)).toBeTruthy();
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
    dryRun: false, matched: 512, filed: [{ id: 't1', category: 'groceries' }], remaining: 200, failed: ['t9', 't10'],
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText('202 still to go — we file up to 300 at a time.')).toBeTruthy();
  expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);   // stays open for the next round
  expect(fns.showToast).not.toHaveBeenCalled();          // the sheet says it; a toast would repeat it
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

  expect(screen.getByText('Filed 1 charge')).toBeTruthy();
  expect(screen.getByText('12 still to go — we file up to 300 at a time.')).toBeTruthy();
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

// "Try again" is a plain button, not a guarded write, so two taps really do put two whole-history
// scans in flight. Whichever the network returns LAST would paint — and the older one is the wrong
// answer. Fail-on-revert: drop the request counter (or use a per-effect `cancelled` flag, which
// cannot see the retry's request) and the stale 999-row plan wins.
it('ignores a stale preview that resolves after a newer one', async () => {
  await mountWithPreview(null);   // first attempt fails → the retry button is on screen

  const first = deferred<ApplyRulesResult | null>();
  const second = deferred<ApplyRulesResult | null>();
  fns.previewRuleApplication.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

  const retry = screen.getByTestId('apply-rules-retry');
  await act(async () => { fireEvent.press(retry); fireEvent.press(retry); });

  // The NEWER request answers first, then the older, slower one straggles in behind it.
  await act(async () => { second.resolve(report({ matched: 4 })); });
  await act(async () => { first.resolve(report({ matched: 999 })); });

  expect(screen.getByText('File 4 charges')).toBeTruthy();
  expect(screen.queryByText('File 999 charges')).toBeNull();
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
