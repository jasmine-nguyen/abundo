// WHIT-517 — the "File by shop" sheets: the shop list, the category pick, and the confirm.
//
// The flow is: pick a shop → pick a category → see a preview of what the rule ACTUALLY sweeps →
// confirm to mint the rule + file the charges. What carries real risk and is pinned here:
//   - the shop list shows the server's groups; tapping one opens the category tree, and picking a
//     category advances to the confirm sheet carrying { group, categoryId } (no refetch);
//   - the confirm sheet previews on mount (dry run) and shows the TRUE count (report.matched), not
//     the group's own count — the rule can sweep other shops too;
//   - a 409 clash (an existing rule already files this shop elsewhere) shows the clash card and
//     offers NO "File" button — there is nothing to write;
//   - the alsoCatches warning appears when the rule would sweep other shops;
//   - confirming calls fileByShop with the captured shop + category.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import type { AppContext } from '../context';
import type { FileByShopOutcome } from '../context';
import type { ApplyRulesResult, UncategorizedMerchantGroup, UncategorizedMerchants } from '../api';
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
  previewFileByShop: jest.fn<(group: UncategorizedMerchantGroup, categoryId: string) => Promise<FileByShopOutcome>>(),
  fileByShop: jest.fn<(group: UncategorizedMerchantGroup, categoryId: string) => Promise<FileByShopOutcome>>(),
};

const CATEGORIES = [
  { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null },
  { id: 'fuel', name: 'Fuel', bucket: 'Living', icon: 'car', color: '#F2C94C', parent: null },
];

const group = (over: Partial<UncategorizedMerchantGroup> = {}): UncategorizedMerchantGroup => ({
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 20,
  samples: ['COLES 1234 RICHMOND'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
  ...over,
});

const merchants = (groups: UncategorizedMerchantGroup[]): UncategorizedMerchants => ({
  unfiled: groups.reduce((n, g) => n + g.count, 0),
  groups,
  ungrouped: { count: 0, samples: [] },
});

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: true, rulesConsidered: 1, unfiled: 20, matched: 20, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 20 }, byRule: [], skippedRules: [],
  filed: [], vanished: [], failed: [], alreadyFiled: [], remaining: 20, createdRule: null,
  ...over,
});

function mountList(groups = [group()]) {
  mockState = {
    sheet: { mode: 'fileByShopList' }, toast: null, categories: CATEGORIES,
    uncategorizedMerchants: merchants(groups), ...fns,
  } as unknown as AppContext;
  return render(<Overlays />);
}

async function mountConfirm(g = group(), categoryId = 'groceries') {
  mockState = {
    sheet: { mode: 'fileByShopConfirm', group: g, categoryId }, toast: null, categories: CATEGORIES,
    uncategorizedMerchants: merchants([g]), ...fns,
  } as unknown as AppContext;
  render(<Overlays />);
  await act(async () => {});   // let the mount-time preview resolve
}

beforeEach(() => { jest.clearAllMocks(); });

// --- the shop list ------------------------------------------------------------

describe('the shop list', () => {
  it('lists the server groups, biggest count shown', () => {
    mountList([group({ merchant: 'Coles', count: 20 }), group({ merchant: 'Kmart', rulePattern: 'kmart', count: 5 })]);
    expect(screen.getByText('Coles')).toBeTruthy();
    expect(screen.getByText('Kmart')).toBeTruthy();
    expect(screen.getAllByTestId('file-by-shop-group').length).toBe(2);
  });

  it('opens the category tree when a shop is tapped', () => {
    mountList();
    expect(screen.queryByTestId('file-by-shop-cat')).toBeNull();
    fireEvent.press(screen.getAllByTestId('file-by-shop-group')[0]);
    expect(screen.getAllByTestId('file-by-shop-cat').length).toBe(CATEGORIES.length);
  });

  // The capture: picking a category must carry BOTH the group and the category into the confirm
  // sheet, so the confirm needs no refetch. Fail-on-revert: pass the wrong pair and this reddens.
  it('advances to the confirm sheet with the chosen shop and category', () => {
    const g = group();
    mountList([g]);
    fireEvent.press(screen.getAllByTestId('file-by-shop-group')[0]);
    fireEvent.press(screen.getByText('Groceries'));   // press the row by name (siblings sort A–Z)
    expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'fileByShopConfirm', group: g, categoryId: 'groceries' });
  });

  it('shows the "every shop is filed" state when there are no groups', () => {
    mountList([]);
    expect(screen.getByText('Every shop is filed')).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-group')).toBeNull();
  });
});

// --- the confirm sheet --------------------------------------------------------

describe('the confirm sheet', () => {
  it('previews on mount and shows the TRUE swept count (report.matched)', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 23 }) });
    await mountConfirm();

    expect(fns.previewFileByShop).toHaveBeenCalledTimes(1);
    // 23, not the group's own count of 20 — the rule sweeps other shops too.
    expect(screen.getByTestId('file-by-shop-confirm-apply')).toBeTruthy();
    expect(screen.getByText('File 23 charges')).toBeTruthy();
  });

  it('files the shop when confirmed, calling fileByShop with the captured pair', async () => {
    const g = group();
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 20 }) });
    fns.fileByShop.mockResolvedValue({ ok: true, report: report({ dryRun: false, matched: 20, filed: [{ id: 't1', category: 'groceries' }] }) });
    await mountConfirm(g, 'groceries');

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(fns.fileByShop).toHaveBeenCalledWith(g, 'groceries');
  });

  // The over-broad-rule guard: the rule would also file other shops, and that must be visible
  // BEFORE the tap. Fail-on-revert: drop the alsoCatches block and the warning is gone.
  it('warns when the rule also sweeps other shops', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 25 }) });
    await mountConfirm(group({ alsoCatches: [{ merchant: 'Coles Express', count: 5 }] }));

    expect(screen.getByTestId('file-by-shop-also-catches')).toBeTruthy();
    expect(screen.getByText('Coles Express — 5 charges')).toBeTruthy();
  });

  // A clash surfaced by the PREVIEW (the server checks even on a dry run). No "File" button — there
  // is nothing to write. Fail-on-revert: collapse the clash outcome and the confirm button returns.
  it('shows the clash card and no File button when the preview reports a clash', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: false, clash: new ApiError(409, null) });
    await mountConfirm();

    expect(screen.getByText('You already have a rule for this')).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-confirm-apply')).toBeNull();
  });

  it('shows the clash card when the WRITE races into a clash', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 20 }) });
    fns.fileByShop.mockResolvedValue({ ok: false, clash: new ApiError(409, null) });
    await mountConfirm();

    await act(async () => { fireEvent.press(screen.getByTestId('file-by-shop-confirm-apply')); });
    expect(screen.getByText('You already have a rule for this')).toBeTruthy();
  });

  // A shop bigger than the write cap can't file in one tap, so the button must not promise the full
  // count. Fail-on-revert: drop the `capped` label and it reads "File 500 charges" — a promise the
  // one call can't keep. APPLY_RULES_MAX_WRITES + 200 guarantees we're over the cap.
  it('says "up to N now" (not the full count) when the shop exceeds the write cap', async () => {
    const over = APPLY_RULES_MAX_WRITES + 200;
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: over }) });
    await mountConfirm();

    expect(screen.getByText(`File up to ${APPLY_RULES_MAX_WRITES} now`)).toBeTruthy();
    expect(screen.queryByText(`File ${over} charges`)).toBeNull();
  });

  // A shop whose charges someone filed between opening the list and here reads matched 0 — offer no
  // no-op "File 0". Fail-on-revert: drop the matched===0 arm and a "File 0 charges" button shows.
  it('says nothing is left when the preview reports matched 0', async () => {
    fns.previewFileByShop.mockResolvedValue({ ok: true, report: report({ matched: 0 }) });
    await mountConfirm();

    expect(screen.getByText('Nothing left to file here')).toBeTruthy();
    expect(screen.queryByTestId('file-by-shop-confirm-apply')).toBeNull();
  });
});
