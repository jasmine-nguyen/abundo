// WHIT-517 — GAP tests for the "File by shop" sheets, adversarial to fileByShopSheet.screen.test.tsx.
// The implementer covered: list renders/tap/pick/empty, confirm previews matched count, files with
// captured pair, alsoCatches warning, clash on preview + write-race, matched===0. NOT covered and
// pinned here:
//   - [A20] preview FAILS (not a clash) → "Couldn't check this shop"; Try again re-runs the preview
//   - [A21] the WRITE fails (not a clash) while on screen → "Couldn't finish"
//   - [A22] a successful file → success toast + returns to the shop list
//   - [A23] a successful file that filed nothing → the "nothing left" toast copy
//   - [A24] dismissing the sheet mid-write → the outcome is TOASTed, not dropped, and it does NOT
//           try to navigate the (unmounted) sheet — the onScreen ref path
//   - [A25] an empty merchant string → the "this shop" fallback copy, not a blank
//   - [A26] a null merchant in alsoCatches → "Unnamed shop", not a blank
//   - [A27] the preview's date range is rendered (TZ Australia/Melbourne, pinned dates)
//   - [A28] the list's error card (background refetch failed) and its ungrouped "one-offs" copy
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { FileByShopOutcome } from '../context';
import { APPLY_RULES_MAX_WRITES } from '../context';
import type { ApplyRulesResult, UncategorizedMerchantGroup, UncategorizedMerchants } from '../api';

let mockState: AppContext;
// Override useUncategorizedMerchants so the list loading/error arms are reachable (the shared
// queryMocksFromState hardcodes isLoading/isError false).
let mockMerchantsResult: { merchants: unknown; isLoading: boolean; isError: boolean };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => {
  const base = require('./support/screenQueryMocks').queryMocksFromState(() => mockState);
  return { ...base, useUncategorizedMerchants: () => mockMerchantsResult };
});

import { Overlays } from '../components/Overlays';

const CATEGORIES = [
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null },
  { id: 'fuel', name: 'Fuel', bucket: 'Living', icon: 'car', color: '#F2C94C', parent: null },
];

const fns = {
  setSheet: jest.fn(),
  showToast: jest.fn(),
  previewFileByShop: jest.fn<(g: UncategorizedMerchantGroup, c: string) => Promise<FileByShopOutcome>>(),
  fileByShop: jest.fn<(g: UncategorizedMerchantGroup, c: string) => Promise<FileByShopOutcome>>(),
};

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

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 20, matched: 20, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 20 }, byRule: [], skippedRules: [],
  filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 20, createdRule: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mountConfirm(g = group(), categoryId = 'groceries') {
  mockState = {
    sheet: { mode: 'fileByShopConfirm', group: g, categoryId }, toast: null, categories: CATEGORIES,
    uncategorizedMerchants: merchants([g]), ...fns,
  } as unknown as AppContext;
  mockMerchantsResult = { merchants: merchants([g]), isLoading: false, isError: false };
  const utils = render(<Overlays />);
  await act(async () => {});   // let the mount-time preview settle
  return utils;
}

beforeEach(() => { jest.clearAllMocks(); });

// --- the confirm sheet: preview + write failure arms --------------------------

describe('confirm sheet — failure arms', () => {
  // [A20] A preview that fails for a NON-clash reason must show its own retry card, and Try again
  // must fire a FRESH preview. Fail-on-revert: drop the previewFailed arm and the busy spinner
  // never resolves into this card; drop the retry wiring and the second preview never fires.
  it('[A20] shows the preview-failed card and retries the preview on "Try again"', async () => {
    fns.previewFileByShop
      .mockResolvedValueOnce({ ok: false, clash: null })
      .mockResolvedValueOnce({ ok: true, report: report({ matched: 20 }) });
    await mountConfirm();

    expect(screen.getByText("Couldn't check this shop")).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-confirm-apply')).toBeNull();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-retry')); });
    expect(fns.previewFileByShop).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('file-by-shop-confirm-apply')).toBeTruthy();
  });

  // [A21] A WRITE that fails for a non-clash reason (unknown outcome) shows the "Couldn't finish"
  // card, NOT the clash card and NOT a success. Fail-on-revert: drop the writeFailed arm and the
  // sheet is stuck on the confirming spinner.
  it('[A21] shows the "Couldn\'t finish" card when the write fails (non-clash)', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 20 }) });
    fns.fileByShop.mockResolvedValue({ ok: false, clash: null });
    await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(screen.getByText("Couldn't finish")).toBeTruthy();
    expect(screen.queryByText('You already have a rule for this')).toBeNull();
    expect(fns.setSheet).not.toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });
});

// --- the confirm sheet: success paths -----------------------------------------

describe('confirm sheet — success', () => {
  // [A22] A successful file toasts the count + chosen category AND returns to the (now-invalidated)
  // shop list. Fail-on-revert: drop the showToast and the toast assertion reddens; drop the
  // setSheet and the navigation assertion reddens.
  it('[A22] toasts the filed count and returns to the shop list on success', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 2 }) });
    fns.fileByShop.mockResolvedValue({ ok: true, report: report({ dryRun: false, matched: 2, filed: [{ id: 't1', category: 'groceries' }, { id: 't2', category: 'groceries' }] }) });
    await mountConfirm(group(), 'groceries');

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(fns.showToast).toHaveBeenCalledWith('Filed 2 charges as Groceries.');
    expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });

  // [A22b] WHIT-517 (folded from qa finding #3): a shop bigger than the write cap files in batches,
  // so the success toast must say more remain — she is bounced back to the list where the shop
  // reappears and needs to know why. Fail-on-revert: drop the `matched > cap` branch and the toast
  // reads a plain "Filed N charges as Groceries." with no "more to go".
  it('[A22b] toasts "more of this shop to go" when the shop exceeds the write cap', async () => {
    const over = APPLY_RULES_MAX_WRITES + 200;
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: over }) });
    fns.fileByShop.mockResolvedValue({ ok: true, report: report({ dryRun: false, matched: over, filed: Array.from({ length: APPLY_RULES_MAX_WRITES }, (_, i) => ({ id: `t${i}`, category: 'groceries' })), remaining: 200 }) });
    await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(fns.showToast).toHaveBeenCalledWith(`Filed ${APPLY_RULES_MAX_WRITES} charges as Groceries — more of this shop to go, tap it again.`);
  });

  // [A23] A success that filed NOTHING (someone else filed the shop between preview and confirm)
  // uses the "nothing left" copy, not "Filed 0 charges". Fail-on-revert: collapse the filed>0
  // branch and this reddens.
  it('[A23] toasts the "nothing left" copy when the write filed zero rows', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 2 }) });
    fns.fileByShop.mockResolvedValue({ ok: true, report: report({ dryRun: false, matched: 0, filed: [] }) });
    await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(fns.showToast).toHaveBeenCalledWith('Nothing left to file for Coles.');
  });
});

// --- the confirm sheet: dismissed mid-write -----------------------------------

describe('confirm sheet — dismissed mid-write', () => {
  // [A24] The sheet is dismissable while a SUCCESSFUL write is in flight. When it settles with
  // nothing on screen, the outcome is still TOASTed, and it must NOT push a sheet onto the dismissed
  // stack. Fail-on-revert: remove the `if (onScreen.current)` guard on the success nav and setSheet
  // fires against a dismissed sheet. (The success toast fires before the guard, so this test pins
  // the NAV guard; [A24b] pins the failure-path else-toast.)
  it('[A24] does not navigate when dismissed mid-write (success settles off screen)', async () => {
    const pending = deferred<FileByShopOutcome>();
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 2 }) });
    fns.fileByShop.mockReturnValue(pending.promise);
    const { rerender } = await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); }); // starts the write
    // Dismiss the sheet while the write is still pending → the confirm sheet unmounts.
    mockState = { ...mockState, sheet: null } as unknown as AppContext;
    await act(async () => { rerender(<Overlays />); });

    await act(async () => { pending.resolve({ ok: true, report: report({ dryRun: false, matched: 2, filed: [{ id: 't1', category: 'groceries' }, { id: 't2', category: 'groceries' }] }) }); });

    expect(fns.showToast).toHaveBeenCalledWith('Filed 2 charges as Groceries.');
    expect(fns.setSheet).not.toHaveBeenCalledWith({ mode: 'fileByShopList' });
  });

  // [A24b] A FAILED write that settles after the sheet is dismissed must TOAST the outcome (not drop
  // it silently) and must NOT setPhase into a card on the unmounted sheet. This is the off-screen
  // ELSE-toast branch [A24] can't reach (its success toast fires before the guard). Fail-on-revert:
  // drop the `else showToast(...)` on the write-failure path and the outcome vanishes with no toast.
  it('[A24b] toasts a failed write that settles after the sheet is dismissed', async () => {
    const pending = deferred<FileByShopOutcome>();
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 2 }) });
    fns.fileByShop.mockReturnValue(pending.promise);
    const { rerender } = await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    mockState = { ...mockState, sheet: null } as unknown as AppContext;
    await act(async () => { rerender(<Overlays />); });

    await act(async () => { pending.resolve({ ok: false, clash: null }); });

    expect(fns.showToast).toHaveBeenCalledWith('Couldn\'t file Coles. Some charges may already have been filed.');
  });
});

// --- the confirm sheet: empty/null merchant + date range ----------------------

describe('confirm sheet — copy edges', () => {
  // [A25] An empty merchant string must fall back to "this shop", never render a blank. Fail-on-
  // revert: drop the `|| 'this shop'` and the body reads "...from  (..." with a gap.
  it('[A25] falls back to "this shop" when the group merchant is empty', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 4 }) });
    await mountConfirm(group({ merchant: '', firstDate: null, lastDate: null }));
    expect(screen.getByText(/from this shop/)).toBeTruthy();
  });

  // [A26] A null merchant in alsoCatches must read "Unnamed shop". Fail-on-revert: drop the
  // `|| 'Unnamed shop'` and the row renders " — 3 charges" with a leading blank.
  it('[A26] renders "Unnamed shop" for a null merchant in alsoCatches', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 25 }) });
    await mountConfirm(group({ alsoCatches: [{ merchant: null, count: 3 }] }));
    expect(screen.getByText('Unnamed shop — 3 charges')).toBeTruthy();
  });

  // [A27] The preview shows the group's date range (TZ Australia/Melbourne, pinned ISO dates).
  // Fail-on-revert: drop the dateRange interpolation and the range text is gone.
  it('[A27] renders the group date range in Melbourne local time', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 20 }) });
    await mountConfirm(group({ firstDate: '2026-06-01', lastDate: '2026-08-04' }));
    expect(screen.getByText(/1 Jun 2026 – 4 Aug 2026/)).toBeTruthy();
  });
});

// --- the shop list: error + ungrouped copy ------------------------------------

function mountList(result: { merchants: unknown; isLoading: boolean; isError: boolean }) {
  mockState = {
    sheet: { mode: 'fileByShopList' }, toast: null, categories: CATEGORIES,
    uncategorizedMerchants: result.merchants, ...fns,
  } as unknown as AppContext;
  mockMerchantsResult = result;
  return render(<Overlays />);
}

describe('the shop list — background states', () => {
  // [A28a] A background refetch that errors (or the payload guard threw) shows the error card, not a
  // crash or a silent empty list. Fail-on-revert: drop the `isError || !merchants` arm and an
  // errored refetch renders "Every shop is filed" over real data.
  it('[A28a] shows the error card when the shop list errors', () => {
    mountList({ merchants: undefined, isLoading: false, isError: true });
    expect(screen.getByText("Couldn't load your shops")).toBeTruthy();
    expect(screen.getByTestId('file-by-shop-close')).toBeTruthy();
  });

  // [A28b] The loading spinner shows only while there is no cached data. Fail-on-revert: drop the
  // `isLoading && !merchants` arm and the busy testID is gone.
  it('[A28b] shows the busy spinner while loading with no cached shops', () => {
    mountList({ merchants: undefined, isLoading: true, isError: false });
    expect(screen.getByTestId('file-by-shop-busy')).toBeTruthy();
  });

  // [A28c] Every shop filed but stray one-offs remain → the ungrouped-count copy, not the bare
  // "nothing left" copy. Fail-on-revert: drop the ungrouped.count branch and the "one-offs" line
  // is gone.
  it('[A28c] names the leftover one-offs when every shop is filed but one-offs remain', () => {
    mountList({ merchants: merchants([], { unfiled: 3, ungrouped: { count: 3, samples: ['ONE OFF'] } }), isLoading: false, isError: false });
    expect(screen.getByText('Every shop is filed')).toBeTruthy();
    expect(screen.getByText(/last 3 unfiled charges are one-offs/)).toBeTruthy();
  });
});
