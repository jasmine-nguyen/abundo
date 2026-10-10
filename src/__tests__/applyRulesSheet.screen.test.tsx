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
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext, ApplyRulesResult, FilingResult, FilingTarget, FilingWhen } from '../context';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth, setAuthStatus } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP_RECORD } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';
import { applyRulesReport } from './support/applyRulesReport';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
};

const filed = (result: ApplyRulesResult): FilingResult => ({ status: 'filed', report: result });
const FAILED: FilingResult = { status: 'failed', background: false };

const CATEGORIES = [
  GROCERIES_TOP_RECORD,
  { id: 'fuel', name: 'Fuel', bucket: 'Living', icon: 'car', parent: null },
];

const report = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
  rulesConsidered: 2, unfiled: 10, matched: 4, byCategory: { groceries: 4 },
  byRule: [{ ruleId: 'r1', value: 'coles', categoryId: 'groceries', count: 4, samples: ['COLES 1234 RICHMOND'] }],
  alreadyFiled: [], remaining: 4,
  ...over,
});

function mount() {
  server.seed('/categories', CATEGORIES);
  const state = { sheet: { mode: 'applyRules' }, toast: null, ...fns } as unknown as AppContext;
  return openOverlays(state, (next) => { mockState = next; });
}

/** Mount and let the mount-time preview resolve. */
async function mountWithPreview(preview: ApplyRulesResult | null) {
  fns.previewFiling.mockResolvedValue(preview ? filed(preview) : FAILED);
  const view = await mount();
  await act(async () => {});
  return view;
}

/** A promise the test resolves itself, so two requests can genuinely overlap. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// --- no rules vs nothing matched (two DIFFERENT states) -----------------------

// The trap: with zero rules the server returns before the history scan, so unfiled is 0. Copy
// keyed only on `matched === 0` would claim she has no unfiled charges while the tab shows 639.
it.each([
  ['no rules yet', report({ rulesConsidered: 0, unfiled: 0, matched: 0, byRule: [], remaining: 0 })],
  ['rules but no hits', report({ rulesConsidered: 2, unfiled: 10, matched: 0, byRule: [], remaining: 0 })],
])('no apply button when nothing can be filed: %s — never "0 unfiled charges"', async (_name, preview) => {
  await mountWithPreview(preview);

  expect(screen.queryByText(/\b0 unfiled/)).toBeNull();
  expect(screen.queryByTestId('apply-rules-apply')).toBeNull();
});

// --- applying -----------------------------------------------------------------

it('files on tap, then closes and toasts on a clean run', async () => {
  await mountWithPreview(report({ matched: 4 }));
  fns.fileCharges.mockResolvedValue(filed(report({
    dryRun: false, matched: 4, filed: [1, 2, 3, 4].map((n) => ({ id: `t${n}`, category: 'groceries' })), remaining: 0,
  })));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(fns.fileCharges).toHaveBeenCalledTimes(1);
  expect(fns.setSheet).toHaveBeenCalledWith(null);
  expect(fns.showToast).toHaveBeenCalledWith('Filed 4 charges with your rules.');
});

// The useInFlightGuard latch flips BEFORE the first await, so two taps in one frame — before
// React redraws the button into its busy state — still file once.
it('files once on a same-frame double tap', async () => {
  await mountWithPreview(report({ matched: 4 }));
  fns.fileCharges.mockResolvedValue(filed(report({ dryRun: false, filed: [{ id: 't1', category: 'groceries' }], remaining: 0 })));

  const button = screen.getByTestId('apply-rules-apply');
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });

  expect(fns.fileCharges).toHaveBeenCalledTimes(1);
});

// --- after a partial run ------------------------------------------------------

// `remaining` counts rows never attempted; `failed` rows WERE attempted and are excluded from it,
// yet they are still unfiled. Offering only `remaining` would strand them.
it('keeps the sheet open with the work left, counting failed rows too', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 512, remaining: 512 }));
  fns.fileCharges.mockResolvedValue(filed(report({
    dryRun: false, matched: 512, remaining: 200, failed: ['t9', 't10'],
    filed: Array.from({ length: 298 }, (_, n) => ({ id: `t${n}`, category: 'groceries' })),
  })));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText(/202 still to go/)).toBeTruthy();
  expect(screen.getByText(/2 we couldn't save/)).toBeTruthy();
  expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);   // stays open for the next round
  expect(fns.showToast).not.toHaveBeenCalled();          // the sheet says it; a toast would repeat it
});

// The app ships through the store and the server through its own deploy, so a released app can
// meet a server that predates this field. Reading it blindly would throw mid-render on every run.
it('renders a write result from a server that does not send alreadyFiled', async () => {
  await mountWithPreview(report({ matched: 4 }));
  const withoutField = report({ dryRun: false, matched: 4, remaining: 2, filed: [] });
  delete (withoutField as { alreadyFiled?: string[] }).alreadyFiled;
  fns.fileCharges.mockResolvedValue(filed(withoutField));

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText(/2 still to go/)).toBeTruthy();
});

// Each round's report describes only ITS round, so reading the total off the last one would
// announce "Filed 39" after filing 639. Fail-on-revert: toast result.filed.length and this reddens.
it('counts the whole job across rounds, not just the last one', async () => {
  await mountWithPreview(report({ unfiled: 639, matched: 639, remaining: 639 }));
  const round = (filed: number, remaining: number) => report({
    dryRun: false, matched: 639, remaining,
    filed: Array.from({ length: filed }, (_, n) => ({ id: `r${remaining}-${n}`, category: 'groceries' })),
  });

  fns.fileCharges.mockResolvedValueOnce(filed(round(300, 339)));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });
  expect(screen.getByText('Filed 300 charges so far')).toBeTruthy();

  fns.fileCharges.mockResolvedValueOnce(filed(round(300, 39)));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });
  expect(screen.getByText('Filed 600 charges so far')).toBeTruthy();

  fns.fileCharges.mockResolvedValueOnce(filed(round(39, 0)));
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

// --- failures -----------------------------------------------------------------

it('offers a retry when the preview fails, and the retry re-previews', async () => {
  await mountWithPreview(null);

  expect(screen.getByText("Couldn't read your rules")).toBeTruthy();
  expect(screen.getByText('Nothing has been changed. Please try again.')).toBeTruthy();

  fns.previewFiling.mockResolvedValue(filed(report({ matched: 4 })));
  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-retry')); });

  expect(fns.previewFiling).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('apply-rules-apply')).toBeTruthy();
});

// A preview is a whole-history scan plus a live rules read. Two in flight cost double the server
// work and can resolve out of order, painting the older answer over the newer — so the retry shares
// the mount call's latch. Fail-on-revert: call runPreview unguarded and the second scan starts.
it('runs one preview even when Try again is double-tapped', async () => {
  await mountWithPreview(null);   // first attempt fails → the retry button is on screen
  expect(fns.previewFiling).toHaveBeenCalledTimes(1);

  const pending = deferred<FilingResult>();
  fns.previewFiling.mockReturnValue(pending.promise);
  const retry = screen.getByTestId('apply-rules-retry');
  await act(async () => { fireEvent.press(retry); fireEvent.press(retry); });

  expect(fns.previewFiling).toHaveBeenCalledTimes(2);   // one retry, not two

  await act(async () => { pending.resolve(filed(report({ matched: 4 }))); });
  expect(screen.getByText('File 4 charges')).toBeTruthy();
});

// The blocker: the server commits row by row, so an abort mid-write can leave charges filed. The
// copy must not claim nothing happened, and must not tell her to pull to refresh — the context
// action already refreshed the caches for her.
it('says the outcome is uncertain when the write fails', async () => {
  await mountWithPreview(report({ matched: 4 }));
  fns.fileCharges.mockResolvedValue(FAILED);

  await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });

  expect(screen.getByText("Couldn't finish")).toBeTruthy();
  expect(screen.getByText(/Some charges may already have been filed/)).toBeTruthy();
  expect(screen.queryByText(/pull down/i)).toBeNull();
  expect(fns.setSheet).not.toHaveBeenCalledWith(null);  // she reads it before it closes
});

// --- multi-round runs (639 unfiled charges, 300 a run) ---------------------------

describe('rounds', () => {
  const roundReport = (over: Partial<ApplyRulesResult> = {}) => report({
    unfiled: 639, matched: 512, byCategory: { groceries: 512 },
    byRule: [{ ruleId: 'r1', value: 'coles', categoryId: 'groceries', count: 512, samples: ['COLES 1234'] }],
    remaining: 512,
    ...over,
  });

  /** `count` filed rows — the shape a capped round actually returns. */
  const filedRows = (count: number, tag = 'a') =>
    Array.from({ length: count }, (_, i) => ({ id: `${tag}${i}`, category: 'groceries' }));

  /** Round 1: a full capped round, leaving the sheet in its partial state with 212 to go. */
  async function firstRound() {
    fns.fileCharges.mockResolvedValueOnce(filed(roundReport({
      dryRun: false, matched: 512, filed: filedRows(300), remaining: 212,
    })));
    await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });
  }

  // --- [A12] the mount effect ---------------------------------------------------

  // The provider's context value changes identity on every toast and every sheet change, and this
  // sheet stays open across several rounds. If the mount effect keys on the context OBJECT rather
  // than the pinned writer, each of those re-renders fires another whole-history scan — seconds of
  // server work, and a fresh report overwriting the round she is mid-way through reading.
  it('does not re-scan history when an unrelated context change re-renders it', async () => {
    const view = await mountWithPreview(roundReport({ matched: 4, unfiled: 10, remaining: 4 }));
    expect(fns.previewFiling).toHaveBeenCalledTimes(1);

    mockState = { ...mockState, toast: 'Saved' } as unknown as AppContext;
    await act(async () => { view.rerender(overlaysTree()); });

    expect(fns.previewFiling).toHaveBeenCalledTimes(1);
    expect(screen.getByText('File 4 charges')).toBeTruthy();   // the same plan, undisturbed
  });

  // --- [A14] the second button needs the first button's latch -------------------

  // The same-frame double-tap latch is proven for the FIRST button. "Apply the rest" is a second
  // entry point into the same write, and two 300-write runs fired one frame apart is the worst
  // double-submit this feature can produce.
  it('files once on a same-frame double tap of "Apply the rest"', async () => {
    await mountWithPreview(roundReport());
    await firstRound();

    fns.fileCharges.mockResolvedValue(filed(roundReport({ dryRun: false, filed: filedRows(212, 'b'), remaining: 0 })));
    const button = screen.getByTestId('apply-rules-continue');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });

    expect(fns.fileCharges).toHaveBeenCalledTimes(2);   // round 1 + ONE round 2
  });

  // --- [A15] a failed round must not leave the last one's numbers up ------------

  // After round 2 dies, "Filed 300 so far / 212 still to go" is no longer true: round 2 may have
  // committed an unknown number on top of it before the connection dropped. The uncertain copy has
  // to REPLACE that, not render beside it.
  it('clears the earlier round numbers when a later round fails', async () => {
    await mountWithPreview(roundReport());
    await firstRound();

    fns.fileCharges.mockResolvedValueOnce(FAILED);
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
    await mountWithPreview(roundReport({ matched: 4, remaining: 4 }));
    fns.fileCharges.mockResolvedValueOnce(filed(roundReport({
      dryRun: false, matched: 4, filed: [], failed: ['t1', 't2', 't3', 't4'], remaining: 0,
    })));

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
    await mountWithPreview(roundReport({ matched: 4, remaining: 4 }));
    const stalledRound = roundReport({
      dryRun: false, matched: 4, filed: [], failed: ['t1', 't2', 't3', 't4'], remaining: 0,
    });

    fns.fileCharges.mockResolvedValueOnce(filed(stalledRound));
    await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-apply')); });
    expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();   // one retry is fair

    fns.fileCharges.mockResolvedValueOnce(filed(stalledRound));       // identical result
    await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });

    expect(screen.getByText("Something's stopping these")).toBeTruthy();
    expect(screen.queryByTestId('apply-rules-continue')).toBeNull();   // no fourth tap offered
    expect(screen.getByTestId('apply-rules-cancel')).toBeTruthy();
  });

  // A round that DOES make progress must never be mistaken for a stalled one.
  it('keeps offering rounds while the work left is shrinking', async () => {
    await mountWithPreview(roundReport());
    await firstRound();

    fns.fileCharges.mockResolvedValueOnce(filed(roundReport({
      dryRun: false, matched: 512, filed: filedRows(200, 'b'), remaining: 12,
    })));
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
    await mountWithPreview(roundReport({ matched: 4, remaining: 4 }));
    fns.fileCharges.mockResolvedValueOnce(filed(roundReport({
      dryRun: false, matched: 4, filed: [], failed: [],
      alreadyFiled: ['t1', 't2', 't3', 't4'], remaining: 0,
    })));

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
    await mountWithPreview(roundReport());
    await firstRound();                                   // filed 300, 212 to go

    fns.fileCharges.mockResolvedValueOnce(filed(roundReport({
      dryRun: false, matched: 512, filed: [], failed: [],
      alreadyFiled: Array.from({ length: 100 }, (_, i) => `x${i}`), remaining: 112,
    })));
    await act(async () => { fireEvent.press(screen.getByTestId('apply-rules-continue')); });

    expect(screen.queryByText("Something's stopping these")).toBeNull();
    expect(screen.getByTestId('apply-rules-continue')).toBeTruthy();   // still worth another tap
    expect(screen.getByText(/112 still to go/)).toBeTruthy();
  });
});

// --- the categories read (WHIT-670) --------------------------------------------

// [A2] a failed categories read must not blank the sheet: the preview still shows and the File
// button still works.
it('[A2] still previews when the categories read fails', async () => {
  server.fail('/categories', 500);
  fns.previewFiling.mockResolvedValue(filed(report()));
  await openOverlays({ sheet: { mode: 'applyRules' }, toast: null, ...fns } as unknown as AppContext, (next) => { mockState = next; });
  await act(async () => {});

  expect(fns.previewFiling).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('apply-rules-apply')).toBeTruthy();
});

// [A4] locked → the real useIsAuthed hides the sheet and no categories are read; on unlock the
// sheet opens, reads categories once, previews once and labels by name.
it('[A4] hides the sheet and reads nothing while locked, then loads on unlock', async () => {
  setAuthStatus('locked');
  await mountWithPreview(report());

  expect(server.sent('GET', '/categories')).toEqual([]);
  expect(fns.previewFiling).not.toHaveBeenCalled();
  expect(screen.queryByTestId('apply-rules-apply')).toBeNull();

  await act(async () => setAuthStatus('authed'));
  await waitFor(() => expect(screen.getByText('"coles" → Groceries · 4 charges')).toBeTruthy());
  expect(fns.previewFiling).toHaveBeenCalledTimes(1);
});
