// WHIT-629 slice 2 (QA) — the edges of the one filing run, through the real AppProvider.
//
// filingRun.provider.screen.test.tsx proves the happy "now vs background" choice. These pin what the
// merge of three copies into one could quietly lose: the sweep never clashes, only a new rule gets
// its NEW badge (direct AND background), the one-run-at-a-time lock, retry with nothing to retry,
// the stable identities the sheets and the lock subscription rely on, and the lock/sign-out/unmount
// teardowns.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { ApplyRulesJob, ApplyRulesResult, FilingResult, FilingTarget, Rule } from '../context';
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

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 999,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SWEEP: FilingTarget = { kind: 'sweep' };
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
const NEW_RULE: FilingTarget = { kind: 'newRule', pattern: '  COLES  ', categoryId: 'groceries', budgetExcluded: true };
const MINTED = { id: 'r-new', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' };
const EXISTING_RULE = { id: 'r-old', field: 'description', operator: 'contains', value: 'woolies', categoryId: 'groceries', isNew: false } as unknown as Rule;

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: false, rulesConsidered: 1, unfiled: 5, matched: 5, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 5 }, byRule: [], skippedRules: [],
  filed: [], vanished: [], failed: [], remaining: 0, createdRule: null, ...over,
} as ApplyRulesResult);

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'j1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}
function mount() { return renderHook(() => useAppContext(), { wrapper }); }
function seedRules() { queryClient.setQueryData<Rule[]>(['rules'], [EXISTING_RULE]); }
function rules() { return queryClient.getQueryData<Rule[]>(['rules']) ?? []; }

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); jest.useFakeTimers(); mockStatus = 'authed'; });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

// [A1] (P0) The plain sweep carries no inline rule, so a 409 is a plain failure on every path.
it('[A1] turns a sweep 409 into a plain failure on preview, file now and start job', async () => {
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));
  mockApi.startApplyRulesJob.mockRejectedValue(new ApiError(409, null));
  const r = mount().result;

  let preview: FilingResult | null = null;
  let now: FilingResult | null = null;
  let background: FilingResult | null = null;
  await act(async () => { preview = await r.current.previewFiling(SWEEP); });
  await act(async () => { now = await r.current.fileCharges(SWEEP, { now: true }); });
  await act(async () => { background = await r.current.fileCharges(SWEEP, { matched: 301 }); });

  expect(preview).toEqual({ status: 'failed', background: false });
  expect(now).toEqual({ status: 'failed', background: false });
  expect(background).toEqual({ status: 'failed', background: true });
});

// [A2] (P0) A shop 409 on preview is a clash (the sheet shows the clash screen, not "couldn't load").
it('[A2] keeps a shop preview 409 as a clash, and any other preview error as a failure', async () => {
  const r = mount().result;
  let clash: FilingResult | null = null;
  let failed: FilingResult | null = null;
  mockApi.applyRulesToUncategorized.mockRejectedValueOnce(new ApiError(409, null));
  await act(async () => { clash = await r.current.previewFiling(SHOP); });
  mockApi.applyRulesToUncategorized.mockRejectedValueOnce(new ApiError(502, null));
  await act(async () => { failed = await r.current.previewFiling(SHOP); });

  expect(clash).toEqual({ status: 'clash', error: expect.any(ApiError), background: false });
  expect(failed).toEqual({ status: 'failed', background: false });
});

// [A3] (P0) A direct clash wrote nothing, so it refreshes nothing; any other direct failure refreshes.
it('[A3] refreshes after a direct failure but not after a direct clash', async () => {
  const r = mount().result;
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  mockApi.applyRulesToUncategorized.mockRejectedValueOnce(new ApiError(409, null));
  await act(async () => { await r.current.fileCharges(SHOP, { now: true }); });
  expect(spy).not.toHaveBeenCalled();

  mockApi.applyRulesToUncategorized.mockRejectedValueOnce(new ApiError(502, null));
  await act(async () => { await r.current.fileCharges(SHOP, { now: true }); });
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A4] (P0) New rule filed now: the TRIMMED pattern + budget flag reach the wire, the minted rule is
// prepended with its NEW badge, and ['rules'] is not refetched (it would wipe the badge).
it('[A4] files a new rule now with the trimmed pattern and shows the minted rule as NEW', async () => {
  seedRules();
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ createdRule: MINTED } as Partial<ApplyRulesResult>));
  const r = mount().result;
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await r.current.fileCharges(NEW_RULE, { matched: 5 }); });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(false, { value: 'COLES', categoryId: 'groceries', budgetExcluded: true });
  expect(rules().map((rule) => [rule.id, rule.isNew])).toEqual([['r-new', true], ['r-old', false]]);
  expect(invalidatedKeys(spy)).not.toContain('rules');
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A5] (P0) A shop run also mints a rule, but it must NOT be shown as NEW — rules refetch instead.
it('[A5] does not prepend the rule a shop run mints, and refetches rules', async () => {
  seedRules();
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ createdRule: MINTED } as Partial<ApplyRulesResult>));
  const r = mount().result;
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await r.current.fileCharges(SHOP, { matched: 5 }); });

  expect(rules().map((rule) => rule.id)).toEqual(['r-old']);
  expect(invalidatedKeys(spy)).toContain('rules');
  spy.mockRestore();
});

// [A6] (P0) The background new-rule job: success prepends the minted rule with its NEW badge.
it('[A6] shows the minted rule as NEW when a background new-rule job succeeds', async () => {
  seedRules();
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'succeeded', createdRule: MINTED } as Partial<ApplyRulesJob>));
  const { result: r } = mount();
  act(() => { r.current.setSheet({ mode: 'addRuleConfirm', pattern: '  COLES  ', categoryId: 'groceries', budgetExcluded: true }); });
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await r.current.fileCharges(NEW_RULE, { matched: 999 }); });
  expect(mockApi.startApplyRulesJob).toHaveBeenCalledWith({ value: 'COLES', categoryId: 'groceries', budgetExcluded: true });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });

  expect(r.current.applyRulesJob?.status).toBe('succeeded');
  expect(rules().map((rule) => [rule.id, rule.isNew])).toEqual([['r-new', true], ['r-old', false]]);
  expect(invalidatedKeys(spy)).not.toContain('rules');
  spy.mockRestore();
});

// [A7] (P1) A background shop job that succeeds does not show its rule as NEW.
it('[A7] does not prepend the rule when a background shop job succeeds', async () => {
  seedRules();
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'succeeded', createdRule: MINTED } as Partial<ApplyRulesJob>));
  const { result: r } = mount();
  act(() => { r.current.setSheet({ mode: 'fileByShopConfirm', group: GROUP, categoryId: 'groceries' }); });
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await r.current.fileCharges(SHOP, { matched: 999 }); });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });

  expect(r.current.applyRulesJob?.status).toBe('succeeded');
  expect(rules().map((rule) => rule.id)).toEqual(['r-old']);
  expect(invalidatedKeys(spy)).toContain('rules');
  spy.mockRestore();
});

// [A8] (P0) One run at a time: while a job is running, filing now is refused without a server call.
it('[A8] refuses to file now while a background job is running', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job());
  const r = mount().result;
  await act(async () => { await r.current.fileCharges(SWEEP, { matched: 999 }); });

  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SHOP, { now: true }); });

  expect(result).toEqual({ status: 'failed', background: false });
  expect(mockApi.applyRulesToUncategorized).not.toHaveBeenCalled();
});

// [A9] (P0) One run at a time: a job can't start while a direct run is still in flight.
it('[A9] refuses to start a background job while a direct run is in flight', async () => {
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const r = mount().result;

  let first!: Promise<FilingResult>;
  act(() => { first = r.current.fileCharges(SWEEP, { now: true }); });
  let second: FilingResult | null = null;
  await act(async () => { second = await r.current.fileCharges(SHOP, { matched: 999 }); });
  expect(second).toEqual({ status: 'failed', background: true });
  expect(mockApi.startApplyRulesJob).not.toHaveBeenCalled();

  await act(async () => { pending.resolve(report()); await first; });
});

// [A10] (P0) 301 is over the cap: without `now`, the run goes to a background job.
it('[A10] sends exactly 301 matched charges to a background job', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job());
  const r = mount().result;
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SWEEP, { matched: 301 }); });

  expect(result).toEqual({ status: 'background' });
  expect(mockApi.startApplyRulesJob).toHaveBeenCalledWith(undefined);
  expect(mockApi.applyRulesToUncategorized).not.toHaveBeenCalled();
});

// [A11] (P1) "Try again" with no job ever started does nothing and says it failed.
it('[A11] answers a retry with nothing to retry as a background failure, calling nothing', async () => {
  const r = mount().result;
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.retryApplyRulesJob(); });

  expect(result).toEqual({ status: 'failed', background: true });
  expect(mockApi.startApplyRulesJob).not.toHaveBeenCalled();
});

// [A12] (P0) Retry restarts the SAME new-rule target (trimmed rule + budget flag) and a success
// still shows the minted rule as NEW.
it('[A12] retries a failed new-rule job with the same rule and still prepends its minted rule', async () => {
  seedRules();
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockRejectedValueOnce(new ApiError(404, null));
  const { result: r } = mount();
  act(() => { r.current.setSheet({ mode: 'addRuleConfirm', pattern: '  COLES  ', categoryId: 'groceries', budgetExcluded: true }); });
  await act(async () => { await r.current.fileCharges(NEW_RULE, { matched: 999 }); });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  expect(r.current.applyRulesJob?.status).toBe('failed');

  mockApi.getApplyRulesJob.mockResolvedValue(job({ status: 'succeeded', createdRule: MINTED } as Partial<ApplyRulesJob>));
  let retried: FilingResult | null = null;
  await act(async () => { retried = await r.current.retryApplyRulesJob(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });

  expect(retried).toEqual({ status: 'background' });
  expect(mockApi.startApplyRulesJob).toHaveBeenCalledTimes(2);
  expect(mockApi.startApplyRulesJob.mock.calls[1][0]).toEqual({ value: 'COLES', categoryId: 'groceries', budgetExcluded: true });
  expect(rules().map((rule) => [rule.id, rule.isNew])).toEqual([['r-new', true], ['r-old', false]]);
});

// [A13] (P0) The sheets' preview effect and the lock subscription hold on to these callbacks, so
// they must keep their identity across a toast, a sheet change and job progress.
it('[A13] keeps previewFiling, fileCharges and retryApplyRulesJob stable across redraws', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job({ matched: 10, attempted: 5 }));
  const { result: r } = mount();
  const first = { preview: r.current.previewFiling, file: r.current.fileCharges, retry: r.current.retryApplyRulesJob };

  act(() => { r.current.showToast('hi'); });
  act(() => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, { matched: 999 }); });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  expect(r.current.applyRulesJob?.matched).toBe(10);

  expect(r.current.previewFiling).toBe(first.preview);
  expect(r.current.fileCharges).toBe(first.file);
  expect(r.current.retryApplyRulesJob).toBe(first.retry);
});

// [A14] (P0) A lock (after many redraws) stops polling, drops the job view and releases the lock.
it('[A14] stops polling, clears the job and frees the lock on a Face ID lock', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job());
  const { result: r } = mount();
  // A confirm sheet stays open through a lock (only the sweep sheet is closed), so the job view
  // must be dropped by the lock itself, not by the dismiss.
  act(() => { r.current.setSheet({ mode: 'fileByShopConfirm', group: GROUP, categoryId: 'groceries' }); });
  act(() => { r.current.showToast('redraw'); });
  await act(async () => { await r.current.fileCharges(SHOP, { matched: 999 }); });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  const polls = mockApi.getApplyRulesJob.mock.calls.length;
  expect(polls).toBeGreaterThan(0);

  act(() => { mockSetStatus('locked'); });
  await act(async () => { await jest.advanceTimersByTimeAsync(20000); });

  expect(r.current.applyRulesJob).toBeNull();
  expect(mockApi.getApplyRulesJob.mock.calls.length).toBe(polls);
  act(() => { mockSetStatus('authed'); });
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());
  let after: FilingResult | null = null;
  await act(async () => { after = await r.current.fileCharges(SWEEP, { now: true }); });
  expect(after).toEqual({ status: 'filed', report: expect.objectContaining({ matched: 5 }) });
});

// [A15] (P0) A preview or direct run settling after sign-out paints nothing and reports a failure.
it('[A15] drops a preview and a direct run that settle after sign-out', async () => {
  seedRules();
  const preview = deferred<ApplyRulesResult>();
  const commit = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValueOnce(preview.promise).mockReturnValueOnce(commit.promise);
  const r = mount().result;

  let previewing!: Promise<FilingResult>;
  let filing!: Promise<FilingResult>;
  act(() => { previewing = r.current.previewFiling(SHOP); });
  act(() => { filing = r.current.fileCharges(NEW_RULE, { now: true }); });
  act(() => { mockSetStatus('anon'); });
  seedRules();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  let previewResult: FilingResult | null = null;
  let fileResult: FilingResult | null = null;
  await act(async () => {
    preview.resolve(report({ dryRun: true }));
    commit.resolve(report({ createdRule: MINTED } as Partial<ApplyRulesResult>));
    previewResult = await previewing;
    fileResult = await filing;
  });

  expect(previewResult).toEqual({ status: 'failed', background: false });
  expect(fileResult).toEqual({ status: 'failed', background: false });
  expect(rules().map((rule) => rule.id)).toEqual(['r-old']);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// [A16] (P1) Unmounting the provider mid-job stops the poll loop.
it('[A16] stops polling when the provider unmounts', async () => {
  mockApi.startApplyRulesJob.mockResolvedValue(job());
  mockApi.getApplyRulesJob.mockResolvedValue(job());
  const { result: r, unmount } = mount();
  act(() => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, { matched: 999 }); });

  unmount();
  await act(async () => { await jest.advanceTimersByTimeAsync(20000); });
  expect(mockApi.getApplyRulesJob).not.toHaveBeenCalled();
});
