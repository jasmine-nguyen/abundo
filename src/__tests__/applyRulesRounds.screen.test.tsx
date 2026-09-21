// WHIT-508 — the multi-ROUND reality of the apply-rules sheet (639 unfiled charges, 300 a run).
//
// applyRulesSheet.screen.test.tsx pins the copy each round produces, including the running total.
// This file pins the things that only exist BETWEEN rounds — the second entry point into the write
// and the states either side of it:
//   [A12] an unrelated re-render must not re-fire a whole-history scan.
//   [A13] the round-1 numbers must not sit on screen while round 2 is still writing.
//   [A14] "Apply the rest" is behind the same double-tap latch as the first button.
//   [A15] a failed later round must CLEAR the earlier round's numbers, not render beside them.
//   [A16] a round whose rows all ERRORED reports work left even though `remaining` is 0.
//   [A17] a round that files nothing and shrinks nothing stops offering another tap.
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

const CATEGORIES = [{ id: 'groceries', name: 'Groceries' }];

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 2, unfiled: 639, matched: 512, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 512 },
  byRule: [{ ruleId: 'r1', value: 'coles', categoryId: 'groceries', count: 512, samples: ['COLES 1234'] }],
  skippedRules: [], filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 512,
  ...over,
});

/** `count` filed rows — the shape a capped round actually returns. */
const filedRows = (count: number, tag = 'a') =>
  Array.from({ length: count }, (_, i) => ({ id: `${tag}${i}`, category: 'groceries' }));

function mount() {
  mockState = { sheet: { mode: 'applyRules' }, toast: null, categories: CATEGORIES, ...fns } as unknown as AppContext;
  return render(<Overlays />);
}

/** Mount and let the mount-time preview resolve. */
async function mountWithPreview(preview: ApplyRulesResult | null) {
  fns.previewRuleApplication.mockResolvedValue(preview);
  const view = mount();
  await act(async () => {});
  return view;
}

/** Round 1: a full capped round, leaving the sheet in its partial state with 212 to go. */
async function firstRound() {
  fns.applyRulesToHistory.mockResolvedValueOnce(report({
    dryRun: false, matched: 512, filed: filedRows(300), remaining: 212,
  }));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });
}

beforeEach(() => { jest.clearAllMocks(); });

// --- [A12] the mount effect ---------------------------------------------------

// The provider's context value changes identity on every toast and every sheet change, and this
// sheet stays open across several rounds. If the mount effect keys on the context OBJECT rather
// than the pinned writer, each of those re-renders fires another whole-history scan — seconds of
// server work, and a fresh report overwriting the round she is mid-way through reading.
it('does not re-scan history when an unrelated context change re-renders it', async () => {
  const view = await mountWithPreview(report({ matched: 4, unfiled: 10, remaining: 4 }));
  expect(fns.previewRuleApplication).toHaveBeenCalledTimes(1);

  mockState = { ...mockState, toast: 'Saved' } as unknown as AppContext;
  await act(async () => { view.rerender(<Overlays />); });

  expect(fns.previewRuleApplication).toHaveBeenCalledTimes(1);
  expect(screen.getByText('File 4 charges')).toBeTruthy();   // the same plan, undisturbed
});

// --- [A13] round 2 is a real write, with its own waiting state ----------------

// A second round is another 300 writes and takes just as long as the first. Leaving "Filed 300 so
// far / 212 still to go" on screen under a live write shows a total that is already out of date,
// and leaves "Apply the rest" tappable a third time.
it('swaps the round-1 numbers for the filing spinner while the next round runs', async () => {
  await mountWithPreview(report());
  await firstRound();
  expect(screen.getByText('Filed 300 charges so far')).toBeTruthy();

  fns.applyRulesToHistory.mockReturnValueOnce(new Promise(() => {}));   // never settles
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });

  expect(screen.getByTestId('apply-rules-busy')).toBeTruthy();
  expect(screen.getByText('Filing your charges…')).toBeTruthy();
  expect(screen.queryByText('Filed 300 charges so far')).toBeNull();
  expect(screen.queryByTestId('apply-rules-continue')).toBeNull();
});

// --- [A14] the second button needs the first button's latch -------------------

// The same-frame double-tap latch is proven for the FIRST button. "Apply the rest" is a second
// entry point into the same write, and two 300-write runs fired one frame apart is the worst
// double-submit this feature can produce.
it('files once on a same-frame double tap of "Apply the rest"', async () => {
  await mountWithPreview(report());
  await firstRound();

  fns.applyRulesToHistory.mockResolvedValue(report({ dryRun: false, filed: filedRows(212, 'b'), remaining: 0 }));
  const button = screen.getByTestId('apply-rules-continue');
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });

  expect(fns.applyRulesToHistory).toHaveBeenCalledTimes(2);   // round 1 + ONE round 2
});

// --- [A15] a failed round must not leave the last one's numbers up ------------

// After round 2 dies, "Filed 300 so far / 212 still to go" is no longer true: round 2 may have
// committed an unknown number on top of it before the connection dropped. The uncertain copy has
// to REPLACE that, not render beside it.
it('clears the earlier round numbers when a later round fails', async () => {
  await mountWithPreview(report());
  await firstRound();

  fns.applyRulesToHistory.mockResolvedValueOnce(null);
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });

  expect(screen.getByText("Couldn't finish")).toBeTruthy();
  expect(screen.queryByText('Filed 300 charges so far')).toBeNull();
  expect(screen.queryByText(/still to go/)).toBeNull();
  expect(screen.queryByTestId('apply-rules-continue')).toBeNull();
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);
});

// --- [A16] work left when `remaining` is zero ---------------------------------

// The shape a round of pure write errors takes: every attempted row errored, so `failed` is full
// and `remaining` — which counts rows never ATTEMPTED — is 0. Those rows are still unfiled. A gate
// on bare `remaining` closes the sheet and toasts "Nothing left for your rules to file" while four
// charges sit exactly where they were.
// Fail-on-revert: change the gate to `result.remaining > 0` → the sheet closes and toasts. The
// other suites' failed-row cases all carry a non-zero `remaining`, so they survive that mutation;
// this is the case where the gate itself is load-bearing.
it('never claims success when every row errored and `remaining` is zero', async () => {
  await mountWithPreview(report({ matched: 4, remaining: 4 }));
  fns.applyRulesToHistory.mockResolvedValueOnce(report({
    dryRun: false, matched: 4, filed: [], failed: ['t1', 't2', 't3', 't4'], remaining: 0,
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(fns.setSheet).not.toHaveBeenCalledWith(null);
  expect(fns.showToast).not.toHaveBeenCalled();
  expect(screen.getByText("Couldn't file any this time")).toBeTruthy();
  expect(screen.getByText("4 still to go (4 we couldn't save).")).toBeTruthy();
});

// --- [A17] the loop has an exit ----------------------------------------------

// Rows left over because they ERRORED are re-attempted by the next round against the same failing
// condition, and the server re-plans from scratch each time — so nothing self-corrects. Offering
// "Apply the rest" on an identical result forever is a loop with no way out.
// Fail-on-revert: always setPhase('done') and the third screen still offers another tap.
it('stops offering another round once one files nothing and shrinks nothing', async () => {
  await mountWithPreview(report({ matched: 4, remaining: 4 }));
  const stalledRound = report({
    dryRun: false, matched: 4, filed: [], failed: ['t1', 't2', 't3', 't4'], remaining: 0,
  });

  fns.applyRulesToHistory.mockResolvedValueOnce(stalledRound);
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });
  expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();   // one retry is fair

  fns.applyRulesToHistory.mockResolvedValueOnce(stalledRound);       // identical result
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });

  expect(screen.getByText("Something's stopping these")).toBeTruthy();
  expect(screen.queryByTestId('apply-rules-continue')).toBeNull();   // no fourth tap offered
  expect(screen.getByTestId('apply-rules-cancel')).toBeTruthy();
});

// A round that DOES make progress must never be mistaken for a stalled one.
it('keeps offering rounds while the work left is shrinking', async () => {
  await mountWithPreview(report());
  await firstRound();

  fns.applyRulesToHistory.mockResolvedValueOnce(report({
    dryRun: false, matched: 512, filed: filedRows(200, 'b'), remaining: 12,
  }));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });

  expect(screen.getByText('Filed 500 charges so far')).toBeTruthy();
  expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();
});

// --- [A50]-[A51] WHIT-508: rows someone else filed mid-run are DONE, not work left ---------

// The work-left sum is `remaining + failed` on purpose. A row the user filed with their own tap
// during the run needs nothing: it is filed, and the next round's scan will not even see it.
// Counting it as work left gives her a round that reports charges to go, then a next round that
// finds nothing and reports the same number again — a button that never finishes.
// Fail-on-revert: add the alreadyFiled count to `stillToGo` and the sheet stays open offering
// "Apply the rest" instead of closing -> red.
it('finishes the run when every attempted row was already filed by the user', async () => {
  await mountWithPreview(report({ matched: 4, remaining: 4 }));
  fns.applyRulesToHistory.mockResolvedValueOnce(report({
    dryRun: false, matched: 4, filed: [], failed: [],
    alreadyFiled: ['t1', 't2', 't3', 't4'], remaining: 0,
  }));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(fns.setSheet).toHaveBeenCalledWith(null);
  // Honest: this round filed nothing itself, so it must not claim a number it did not write.
  expect(fns.showToast).toHaveBeenCalledWith('Nothing left for your rules to file.');
  expect(screen.queryByTestId('apply-rules-continue')).toBeNull();
});

// A round can file nothing ITSELF and still be progress: the user (or another device) filed those
// rows during it, so the work left genuinely shrank. Judging "stuck" on `filed.length === 0` alone
// would slam the door on a run that is finishing normally and tell her something is wrong.
// Fail-on-revert: drop the "did the work left shrink" half of the stall test -> red.
it('does not call a round stuck when someone else filed the rows it skipped', async () => {
  await mountWithPreview(report());
  await firstRound();                                   // filed 300, 212 to go

  fns.applyRulesToHistory.mockResolvedValueOnce(report({
    dryRun: false, matched: 512, filed: [], failed: [],
    alreadyFiled: Array.from({ length: 100 }, (_, i) => `x${i}`), remaining: 112,
  }));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });

  expect(screen.queryByText("Something's stopping these")).toBeNull();
  expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();   // still worth another tap
  expect(screen.getByText(/112 still to go/)).toBeTruthy();
});
