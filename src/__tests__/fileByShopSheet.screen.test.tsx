// WHIT-517 — the "File by shop" sheets: the shop list, the category pick, and the confirm.
//
// The flow is: pick a shop → pick a category → see a preview of what the rule ACTUALLY sweeps →
// confirm to mint the rule + file the charges. What carries real risk and is pinned here:
//   - picking a category advances to the confirm sheet carrying { group, categoryId } (no refetch);
//   - the confirm sheet previews on mount (dry run) and shows the TRUE count (report.matched), not
//     the group's own count — the rule can sweep other shops too;
//   - a 409 clash (an existing rule already files this shop elsewhere) shows the clash card and
//     offers NO "File" button — there is nothing to write;
//   - the alsoCatches warning appears when the rule would sweep other shops;
//   - confirming calls fileByShop with the captured shop + category;
//   - preview/write failures, success toasts, and outcomes that settle after the sheet is dismissed;
//   - the list's error card and the "Select to file" one-offs jump.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { FilingResult, FilingTarget, FilingWhen } from '../context';
import type { UncategorizedMerchantGroup, UncategorizedMerchants } from '../api';
import { APPLY_RULES_MAX_WRITES } from '../context';
import { ApiError } from '../apiError';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';
import { shopPreviewReport as report } from './support/applyRulesReport';

const server = installFakeServer();
useTestQueryClient();

const MERCHANTS = '/transactions/uncategorized/merchants';

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  requestUncategorizedSelect: jest.fn(),  // WHIT-544: the "Select to file" jump
  previewFiling: jest.fn<(target: FilingTarget) => Promise<FilingResult>>(),
  fileCharges: jest.fn<(target: FilingTarget, when: FilingWhen) => Promise<FilingResult>>(),
};

const CATEGORIES = [
  GROCERIES_TOP,
  { id: 'fuel', name: 'Fuel', bucket: 'Living', icon: 'car', color: '#F2C94C', parent: null },
];

const group = (over: Partial<UncategorizedMerchantGroup> = {}): UncategorizedMerchantGroup => ({
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20,
  samples: ['COLES 1234 RICHMOND'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
  ...over,
});

const merchants = (groups: UncategorizedMerchantGroup[], over: Partial<UncategorizedMerchants> = {}): UncategorizedMerchants => ({
  unfiled: groups.reduce((n, g) => n + g.count, 0),
  groups,
  ungrouped: { count: 0, samples: [] },
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// The shops load once the sheet opens, so each list test waits for them before it checks.
// A server.fail() on the shop list wins over this seed.
function mountList(payload = merchants([group()])) {
  server.seed('/categories', CATEGORIES);
  server.seed(MERCHANTS, payload);
  const state = { sheet: { mode: 'fileByShopList' }, toast: null, ...fns } as unknown as AppContext;
  return openOverlays(state, (next) => { mockState = next; });
}

async function mountConfirm(g = group(), categoryId = 'groceries') {
  server.seed('/categories', CATEGORIES);
  const state = { sheet: { mode: 'fileByShopConfirm', group: g, categoryId }, toast: null, ...fns } as unknown as AppContext;
  const utils = await openOverlays(state, (next) => { mockState = next; });
  await act(async () => {});   // let the mount-time preview resolve
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

// --- the shop list ------------------------------------------------------------

describe('the shop list', () => {
  // The capture: picking a category must carry BOTH the group and the category into the confirm
  // sheet, so the confirm needs no refetch. Fail-on-revert: pass the wrong pair and this reddens.
  it('advances to the confirm sheet with the chosen shop and category', async () => {
    const g = group();
    await mountList(merchants([g]));
    fireEvent.press((await screen.findAllByTestId('file-by-shop-group'))[0]);
    fireEvent.press(screen.getByText('Groceries'));   // press the row by name (siblings sort A–Z)
    expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'fileByShopConfirm', group: g, categoryId: 'groceries' });
  });

  // [A28a] A background refetch that errors (or the payload guard threw) shows the error card, not a
  // crash or a silent empty list. Fail-on-revert: drop the `isError || !merchants` arm and an
  // errored refetch renders "Every shop is filed" over real data.
  it('[A28a] shows the error card when the shop list errors', async () => {
    server.fail(MERCHANTS, 500);
    await mountList();
    expect(await screen.findByText("Couldn't load your shops")).toBeTruthy();
    expect(screen.getByTestId('file-by-shop-close')).toBeTruthy();
  });

  // WHIT-544 — [A28d] with one-offs present, the "Select to file" button shows and, when tapped,
  // arms the Uncategorized multi-select jump AND closes the sheet. Fail-on-revert: drop the button
  // and getByTestId throws; drop either onPress call and its assertion fails.
  it('[A28d] "Select to file" arms the multi-select jump and closes the sheet', async () => {
    await mountList(merchants([], { unfiled: 3, ungrouped: { count: 3, samples: ['ONE OFF'] } }));
    fireEvent.press(await screen.findByTestId('file-by-shop-one-offs'));
    expect(fns.requestUncategorizedSelect).toHaveBeenCalledTimes(1);
    expect(fns.setSheet).toHaveBeenCalledWith(null);
  });
});

// --- the confirm sheet --------------------------------------------------------

describe('the confirm sheet', () => {
  it('previews on mount and shows the TRUE swept count (report.matched)', async () => {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 23 }) });
    await mountConfirm();

    expect(fns.previewFiling).toHaveBeenCalledTimes(1);
    // 23, not the group's own count of 20 — the rule sweeps other shops too.
    expect(screen.getByTestId('file-by-shop-confirm-apply')).toBeTruthy();
    expect(screen.getByText('File 23 charges')).toBeTruthy();
  });

  it('files the shop when confirmed, calling fileByShop with the captured pair', async () => {
    const g = group();
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 20 }) });
    fns.fileCharges.mockResolvedValue({ status: 'filed', report: report({ dryRun: false, matched: 20, filed: [{ id: 't1', category: 'groceries' }] }) });
    await mountConfirm(g, 'groceries');

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(fns.fileCharges).toHaveBeenCalledWith({ kind: 'shop', group: g, categoryId: 'groceries' }, { now: true });
  });

  // The over-broad-rule guard: the rule would also file other shops, and that must be visible
  // BEFORE the tap. Fail-on-revert: drop the alsoCatches block and the warning is gone.
  it('warns when the rule also sweeps other shops', async () => {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 25 }) });
    await mountConfirm(group({ alsoCatches: [{ merchant: 'Coles Express', count: 5 }] }));

    expect(screen.getByTestId('file-by-shop-also-catches')).toBeTruthy();
    expect(screen.getByText('Coles Express — 5 charges')).toBeTruthy();
  });

  // A clash surfaced by the PREVIEW (the server checks even on a dry run). No "File" button — there
  // is nothing to write. Fail-on-revert: collapse the clash outcome and the confirm button returns.
  it('shows the clash card and no File button when the preview reports a clash', async () => {
    fns.previewFiling.mockResolvedValue({ status: 'clash', error: new ApiError(409, null), background: false });
    await mountConfirm();

    expect(screen.getByText('You already have a rule for this')).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-confirm-apply')).toBeNull();
  });

  it('shows the clash card when the WRITE races into a clash', async () => {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 20 }) });
    fns.fileCharges.mockResolvedValue({ status: 'clash', error: new ApiError(409, null), background: false });
    await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(screen.getByText('You already have a rule for this')).toBeTruthy();
  });

  // A shop bigger than the write cap can't file in one tap, so the button must not promise the full
  // count. Fail-on-revert: drop the `capped` label and it reads "File 500 charges" — a promise the
  // one call can't keep. APPLY_RULES_MAX_WRITES + 200 guarantees we're over the cap.
  it('says "up to N now" (not the full count) when the shop exceeds the write cap', async () => {
    const over = APPLY_RULES_MAX_WRITES + 200;
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: over }) });
    await mountConfirm();

    expect(screen.getByText(`File up to ${APPLY_RULES_MAX_WRITES} now`)).toBeTruthy();
    expect(screen.queryByText(`File ${over} charges`)).toBeNull();
  });

  // A shop whose charges someone filed between opening the list and here reads matched 0 — offer no
  // no-op "File 0". Fail-on-revert: drop the matched===0 arm and a "File 0 charges" button shows.
  it('says nothing is left when the preview reports matched 0', async () => {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 0 }) });
    await mountConfirm();

    expect(screen.getByText('Nothing left to file here')).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-confirm-apply')).toBeNull();
  });
});

describe('confirm sheet — failure arms', () => {
  // [A20] A preview that fails for a NON-clash reason must show its own retry card, and Try again
  // must fire a FRESH preview. Fail-on-revert: drop the previewFailed arm and the busy spinner
  // never resolves into this card; drop the retry wiring and the second preview never fires.
  it('[A20] shows the preview-failed card and retries the preview on "Try again"', async () => {
    fns.previewFiling
      .mockResolvedValueOnce({ status: 'failed', background: false })
      .mockResolvedValueOnce({ status: 'filed', report: report({ matched: 20 }) });
    await mountConfirm();

    expect(screen.getByText("Couldn't check this shop")).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-confirm-apply')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-retry')); });
    expect(fns.previewFiling).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('file-by-shop-confirm-apply')).toBeTruthy();
  });

  // [A21] A WRITE that fails for a non-clash reason (unknown outcome) shows the "Couldn't finish"
  // card, NOT the clash card and NOT a success. Fail-on-revert: drop the writeFailed arm and the
  // sheet is stuck on the confirming spinner.
  it('[A21] shows the "Couldn\'t finish" card when the write fails (non-clash)', async () => {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 20 }) });
    fns.fileCharges.mockResolvedValue({ status: 'failed', background: false });
    await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(screen.getByText("Couldn't finish")).toBeTruthy();
    expect(screen.queryByText('You already have a rule for this')).toBeNull();
    expect(fns.setSheet).not.toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });
});

describe('confirm sheet — success', () => {
  // [A22] A successful file toasts the count + chosen category AND returns to the (now-invalidated)
  // shop list. Fail-on-revert: drop the showToast or the setSheet and its assertion reddens.
  it('[A22] toasts the filed count and returns to the shop list on success', async () => {
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
    fns.fileCharges.mockResolvedValue({ status: 'filed', report: report({ dryRun: false, matched: 2, filed: [{ id: 't1', category: 'groceries' }, { id: 't2', category: 'groceries' }] }) });
    await mountConfirm(group(), 'groceries');

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(fns.showToast).toHaveBeenCalledWith('Filed 2 charges as Groceries.');
    expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });

  // [A22b] A shop bigger than the write cap files in batches, so the success toast must say more
  // remain — she is bounced back to the list where the shop reappears and needs to know why.
  // Fail-on-revert: drop the `matched > cap` branch and the toast has no "more to go".
  it('[A22b] toasts "more of this shop to go" when the shop exceeds the write cap', async () => {
    const over = APPLY_RULES_MAX_WRITES + 200;
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: over }) });
    fns.fileCharges.mockResolvedValue({ status: 'filed', report: report({ dryRun: false, matched: over, filed: Array.from({ length: APPLY_RULES_MAX_WRITES }, (_, i) => ({ id: `t${i}`, category: 'groceries' })), remaining: 200 }) });
    await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(fns.showToast).toHaveBeenCalledWith(`Filed ${APPLY_RULES_MAX_WRITES} charges as Groceries — more of this shop to go, tap it again.`);
  });
});

// The sheet is dismissable while the write is in flight. An outcome settling with nothing on screen
// must still be TOASTed (not dropped), and must NOT navigate the dismissed sheet.
describe('confirm sheet — dismissed mid-write', () => {
  async function startWriteThenDismiss() {
    const pending = deferred<FilingResult>();
    fns.previewFiling.mockResolvedValue({ status: 'filed', report: report({ matched: 2 }) });
    fns.fileCharges.mockReturnValue(pending.promise);
    const { rerender } = await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); }); // starts the write
    mockState = { ...mockState, sheet: null } as unknown as AppContext;                            // dismiss
    await act(async () => { rerender(overlaysTree()); });
    return pending;
  }

  // [A24] Fail-on-revert: remove the `if (onScreen.current)` guard on the success nav and setSheet
  // fires against a dismissed sheet.
  it('[A24] does not navigate when dismissed mid-write (success settles off screen)', async () => {
    const pending = await startWriteThenDismiss();
    await act(async () => { pending.resolve({ status: 'filed', report: report({ dryRun: false, matched: 2, filed: [{ id: 't1', category: 'groceries' }, { id: 't2', category: 'groceries' }] }) }); });

    expect(fns.showToast).toHaveBeenCalledWith('Filed 2 charges as Groceries.');
    expect(fns.setSheet).not.toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });

  // [A24b] Fail-on-revert: drop the `else showToast(...)` on the write-failure path and the outcome
  // vanishes with no toast.
  it('[A24b] toasts a failed write that settles after the sheet is dismissed', async () => {
    const pending = await startWriteThenDismiss();
    await act(async () => { pending.resolve({ status: 'failed', background: false }); });

    expect(fns.showToast).toHaveBeenCalledWith('Couldn\'t file Coles. Some charges may already have been filed.');
  });

  // [A29] WHIT-557 — the off-screen 409-CLASH. Fail-on-revert: drop the `else clashToast()` on the
  // shell's clash branch and a clash landing off screen is dropped silently.
  it('[A29] toasts a 409-clash that settles after the sheet is dismissed', async () => {
    const pending = await startWriteThenDismiss();
    await act(async () => { pending.resolve({ status: 'clash', error: new ApiError(409, null), background: false }); });

    expect(fns.showToast).toHaveBeenCalledWith('You already have a rule filing Coles somewhere else.');
    expect(fns.setSheet).not.toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });
});
