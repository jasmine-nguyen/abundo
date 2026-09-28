// WHIT-629 slice 2 — one filing run through the app's data context.
//
// A sheet says what to file (a FilingTarget) and how many charges the preview matched; the context
// picks "file now" or "background job" and hands back one FilingResult. These tests prove the
// choice lives in the context, not the sheet, and that every path answers in the same shape.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { ApplyRulesJob, ApplyRulesResult, FilingResult, FilingTarget } from '../context';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
jest.mock('../api');
jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 999,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
const SWEEP: FilingTarget = { kind: 'sweep' };

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: false, rulesConsidered: 1, unfiled: 999, matched: 999, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 300 }, byRule: [], skippedRules: [],
  filed: [], vanished: [], failed: [], remaining: 699, ...over,
} as ApplyRulesResult);

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); jest.useFakeTimers(); mockStatus = 'authed'; });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

it('sends a shop run over 300 charges to a background job and says so', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());

  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SHOP, { matched: 999 }); });

  expect(result).toEqual({ status: 'background' });
  expect(mockApi.startApplyRulesJob).toHaveBeenCalledWith({ value: 'coles', categoryId: 'groceries' });
  expect(mockApi.applyRulesToUncategorized).not.toHaveBeenCalled();
  expect(r.current.applyRulesJob?.status).toBe('running');
});

it('files a shop run of 300 charges now and returns the report', async () => {
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ matched: 300, remaining: 0 }));

  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SHOP, { matched: 300 }); });

  expect(result).toEqual({ status: 'filed', report: expect.objectContaining({ matched: 300 }) });
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(false, { value: 'coles', categoryId: 'groceries' });
  expect(mockApi.startApplyRulesJob).not.toHaveBeenCalled();
});

it('files the first 300 now, even over the cap, when the user picks "file up to 300"', async () => {
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());

  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SWEEP, { matched: 999, now: true }); });

  expect(result).toEqual({ status: 'filed', report: expect.objectContaining({ matched: 999 }) });
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledTimes(1);
  expect(mockApi.applyRulesToUncategorized.mock.calls[0][0]).toBe(false);
  expect(mockApi.applyRulesToUncategorized.mock.calls[0][1]).toBeUndefined();
  expect(mockApi.startApplyRulesJob).not.toHaveBeenCalled();
});

it('reports a rule clash with where it came from: filing now vs starting a job', async () => {
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));
  mockApi.startApplyRulesJob.mockRejectedValue(new ApiError(409, null));

  const r = mount();
  let now: FilingResult | null = null;
  let background: FilingResult | null = null;
  await act(async () => { now = await r.current.fileCharges(SHOP, { matched: 5 }); });
  await act(async () => { background = await r.current.fileCharges(SHOP, { matched: 999 }); });

  expect(now).toEqual({ status: 'clash', error: expect.any(ApiError), background: false });
  expect(background).toEqual({ status: 'clash', error: expect.any(ApiError), background: true });
});

it('previews through the same module and returns the same result shape', async () => {
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ dryRun: true }));

  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.previewFiling(SHOP); });

  expect(result).toEqual({ status: 'filed', report: expect.objectContaining({ dryRun: true, matched: 999 }) });
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(true, { value: 'coles', categoryId: 'groceries' });
});
