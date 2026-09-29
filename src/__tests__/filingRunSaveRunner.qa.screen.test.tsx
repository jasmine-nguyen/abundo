// WHIT-647 (QA) — the failure half of the filing runs on the save runner. A 409 (clash) or a 502
// that lands after sign-out must come back as a plain failure: no clash sheet, no refresh, and the
// one-run-at-a-time lock released.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { FilingResult, FilingTarget } from '../context';
import { useFilingRun } from '../filingRun';
import { runOptimisticSave, type SaveSteps } from '../optimisticSave';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (status: typeof mockStatus) => { mockStatus = status; mockListeners.forEach((l) => l()); };
jest.mock('../api');
jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 1,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
const FAILED = { status: 'failed', background: false };

function deferredReject() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<never>((_, r) => { reject = r; });
  return { promise, reject };
}

function mountHook(isSameSession: () => boolean) {
  const runSave = <R, T>(steps: SaveSteps<R, T>) => runOptimisticSave(isSameSession, steps);
  return renderHook(() => useFilingRun({
    sessionEpoch: { current: 0 }, runSave, prependMintedRule: jest.fn(), sheetOpen: true,
  })).result;
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); mockStatus = 'authed'; });
afterEach(() => { queryClient.clear(); });

// [A1] (P0) The runner's session verdict beats the clash mapping for both preview and file now.
it('[A1] turns a shop clash into a plain failure when the runner says signed out', async () => {
  const r = mountHook(() => false);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));

  let preview: FilingResult | null = null;
  let now: FilingResult | null = null;
  await act(async () => { preview = await r.current.previewFiling(SHOP); });
  await act(async () => { now = await r.current.fileCharges(SHOP, { now: true }); });

  expect(preview).toEqual(FAILED);
  expect(now).toEqual(FAILED);
  expect(spy).not.toHaveBeenCalled();
});

// [A2] (P0) A failing "file now" while signed out refreshes nothing and still frees the lock.
it('[A2] frees the lock after a failed file now the runner dropped, then refreshes on a live failure', async () => {
  let sameSession = false;
  const r = mountHook(() => sameSession);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(502, null));

  await act(async () => { await r.current.fileCharges(SHOP, { now: true }); });
  expect(spy).not.toHaveBeenCalled();

  sameSession = true;
  let again: FilingResult | null = null;
  await act(async () => { again = await r.current.fileCharges(SHOP, { now: true }); });
  expect(again).toEqual(FAILED);
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledTimes(2);
  expect(spy).toHaveBeenCalled();
});

// [A3] (P0) Through the real provider: a clash that lands after sign-out shows no clash and
// refreshes nothing, for preview and file now.
it('[A3] drops a preview clash and a file-now clash that land after sign-out', async () => {
  const preview = deferredReject();
  const commit = deferredReject();
  mockApi.applyRulesToUncategorized.mockReturnValueOnce(preview.promise).mockReturnValueOnce(commit.promise);
  const r = renderHook(() => useAppContext(), {
    wrapper: ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>,
  }).result;

  let previewing!: Promise<FilingResult>;
  let filing!: Promise<FilingResult>;
  act(() => { previewing = r.current.previewFiling(SHOP); });
  act(() => { filing = r.current.fileCharges(SHOP, { now: true }); });
  act(() => { mockSetStatus('anon'); });
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  let previewResult: FilingResult | null = null;
  let fileResult: FilingResult | null = null;
  await act(async () => {
    preview.reject(new ApiError(409, null));
    commit.reject(new ApiError(409, null));
    previewResult = await previewing;
    fileResult = await filing;
  });

  expect(previewResult).toEqual(FAILED);
  expect(fileResult).toEqual(FAILED);
  expect(spy).not.toHaveBeenCalled();
});
