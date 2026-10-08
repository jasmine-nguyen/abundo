// WHIT-629 slice 2 (QA) — the edges of the one filing run, through the real AppProvider.
//
// filingRun.provider.screen.test.tsx proves the happy "now vs background" choice. These pin what the
// merge of three copies into one could quietly lose: the sweep never clashes, only a new rule gets
// its NEW badge (direct AND background), the one-run-at-a-time lock, retry with nothing to retry,
// the stable identities the sheets and the lock subscription rely on, and the lock/sign-out/unmount
// teardowns.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { ApplyRulesJob, ApplyRulesResult, FilingResult, FilingTarget } from '../context';
import type { Rule } from '../model';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { applyRulesReport } from './support/applyRulesReport';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
const APPLY_RULES = '/transactions/uncategorized/apply-rules';
const JOBS = `${APPLY_RULES}/jobs`;
const posts = (path: string) => server.sent('POST', path);
const polls = () => server.sentUnder('GET', `${JOBS}/`).length;

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 999,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SWEEP: FilingTarget = { kind: 'sweep' };
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
const NEW_RULE: FilingTarget = { kind: 'newRule', pattern: '  COLES  ', categoryId: 'groceries', budgetExcluded: true };
const MINTED = { id: 'r-new', field: 'description', operator: 'contains', value: 'COLES', categoryId: 'groceries' };
const EXISTING_RULE = { id: 'r-old', field: 'description', operator: 'contains', value: 'woolies', categoryId: 'groceries', isNew: false } as unknown as Rule;

const report = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
  dryRun: false, rulesConsidered: 1, unfiled: 5, matched: 5, byCategory: { groceries: 5 }, createdRule: null,
  ...over,
});

const job = (over: Partial<ApplyRulesJob> = {}): ApplyRulesJob => ({
  jobId: 'job-1', status: 'running', matched: 0, attempted: 0, filed: 0, vanished: 0,
  failed: 0, alreadyFiled: 0, remaining: 0, createdRule: null, error: null,
  createdAt: 't0', updatedAt: 't0', completedAt: null, ...over,
});

function mount() { return renderHook(() => useAppContext(), { wrapper }); }
function seedRules() { queryClient.setQueryData<Rule[]>(['rules'], [EXISTING_RULE]); }
function rules() { return queryClient.getQueryData<Rule[]>(['rules']) ?? []; }

beforeEach(() => { queryClient.clear(); jest.useFakeTimers(); resetAuth(); });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

// [A1] (P0) The plain sweep carries no inline rule, so a 409 is a plain failure on every path.
it('[A1] turns a sweep 409 into a plain failure on preview, file now and start job', async () => {
  server.fail(APPLY_RULES, 409);
  server.fail(JOBS, 409);
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
  server.once('POST', APPLY_RULES, { status: 409 });
  await act(async () => { clash = await r.current.previewFiling(SHOP); });
  server.once('POST', APPLY_RULES, { status: 502 });
  await act(async () => { failed = await r.current.previewFiling(SHOP); });

  expect(clash).toEqual({ status: 'clash', error: expect.any(ApiError), background: false });
  expect(failed).toEqual({ status: 'failed', background: false });
});

// [A3] (P0) A direct clash wrote nothing, so it refreshes nothing; any other direct failure refreshes.
it('[A3] refreshes after a direct failure but not after a direct clash', async () => {
  const r = mount().result;
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  server.once('POST', APPLY_RULES, { status: 409 });
  await act(async () => { await r.current.fileCharges(SHOP, { now: true }); });
  expect(spy).not.toHaveBeenCalled();

  server.once('POST', APPLY_RULES, { status: 502 });
  await act(async () => { await r.current.fileCharges(SHOP, { now: true }); });
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A4] (P0) New rule filed now: the TRIMMED pattern + budget flag reach the wire, the minted rule is
// prepended with its NEW badge, and ['rules'] is not refetched (it would wipe the badge).
it('[A4] files a new rule now with the trimmed pattern and shows the minted rule as NEW', async () => {
  seedRules();
  server.seed(APPLY_RULES, report({ createdRule: MINTED }));
  const r = mount().result;
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await r.current.fileCharges(NEW_RULE, { matched: 5 }); });

  expect(server.requests()).toContainEqual({ method: 'POST', path: APPLY_RULES, body: { dryRun: false, rule: { value: 'COLES', categoryId: 'groceries', budgetExcluded: true } } });
  expect(rules().map((rule) => [rule.id, rule.isNew])).toEqual([['r-new', true], ['r-old', false]]);
  expect(invalidatedKeys(spy)).not.toContain('rules');
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// [A5] (P0) A shop run also mints a rule, but it must NOT be shown as NEW — rules refetch instead.
it('[A5] does not prepend the rule a shop run mints, and refetches rules', async () => {
  seedRules();
  server.seed(APPLY_RULES, report({ createdRule: MINTED }));
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
  const { result: r } = mount();
  act(() => { r.current.setSheet({ mode: 'addRuleConfirm', pattern: '  COLES  ', categoryId: 'groceries', budgetExcluded: true }); });
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await r.current.fileCharges(NEW_RULE, { matched: 999 }); });
  server.seed(`${JOBS}/job-1`, job({ status: 'succeeded', createdRule: MINTED } as Partial<ApplyRulesJob>));
  expect(server.requests()).toContainEqual({ method: 'POST', path: JOBS, body: { rule: { value: 'COLES', categoryId: 'groceries', budgetExcluded: true } } });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });

  expect(r.current.applyRulesJob?.status).toBe('succeeded');
  expect(rules().map((rule) => [rule.id, rule.isNew])).toEqual([['r-new', true], ['r-old', false]]);
  expect(invalidatedKeys(spy)).not.toContain('rules');
  spy.mockRestore();
});

// [A7] (P1) A background shop job that succeeds does not show its rule as NEW.
it('[A7] does not prepend the rule when a background shop job succeeds', async () => {
  seedRules();
  const { result: r } = mount();
  act(() => { r.current.setSheet({ mode: 'fileByShopConfirm', group: GROUP, categoryId: 'groceries' }); });
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await r.current.fileCharges(SHOP, { matched: 999 }); });
  server.seed(`${JOBS}/job-1`, job({ status: 'succeeded', createdRule: MINTED } as Partial<ApplyRulesJob>));
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });

  expect(r.current.applyRulesJob?.status).toBe('succeeded');
  expect(rules().map((rule) => rule.id)).toEqual(['r-old']);
  expect(invalidatedKeys(spy)).toContain('rules');
  spy.mockRestore();
});

// [A8] (P0) One run at a time: while a job is running, filing now is refused without a server call.
it('[A8] refuses to file now while a background job is running', async () => {
  const r = mount().result;
  await act(async () => { await r.current.fileCharges(SWEEP, { matched: 999 }); });
  server.seed(`${JOBS}/job-1`, job());

  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SHOP, { now: true }); });

  expect(result).toEqual({ status: 'failed', background: false });
  expect(posts(APPLY_RULES)).toHaveLength(0);
});

// [A9] (P0) One run at a time: a job can't start while a direct run is still in flight.
it('[A9] refuses to start a background job while a direct run is in flight', async () => {
  server.once('POST', APPLY_RULES, { body: report() });
  const pending = server.hold(APPLY_RULES);
  const r = mount().result;

  let first!: Promise<FilingResult>;
  act(() => { first = r.current.fileCharges(SWEEP, { now: true }); });
  let second: FilingResult | null = null;
  await act(async () => { second = await r.current.fileCharges(SHOP, { matched: 999 }); });
  expect(second).toEqual({ status: 'failed', background: true });
  expect(posts(JOBS)).toHaveLength(0);

  await act(async () => { pending.release(); await first; });
});

// [A10] (P0) 301 is over the cap: without `now`, the run goes to a background job.
it('[A10] sends exactly 301 matched charges to a background job', async () => {
  const r = mount().result;
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SWEEP, { matched: 301 }); });

  expect(result).toEqual({ status: 'background' });
  expect(server.requests()).toContainEqual({ method: 'POST', path: JOBS, body: {} });
  expect(posts(APPLY_RULES)).toHaveLength(0);
});

// [A11] (P1) "Try again" with no job ever started does nothing and says it failed.
it('[A11] answers a retry with nothing to retry as a background failure, calling nothing', async () => {
  const r = mount().result;
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.retryApplyRulesJob(); });

  expect(result).toEqual({ status: 'failed', background: true });
  expect(posts(JOBS)).toHaveLength(0);
});

// [A12] (P0) Retry restarts the SAME new-rule target (trimmed rule + budget flag) and a success
// still shows the minted rule as NEW.
it('[A12] retries a failed new-rule job with the same rule and still prepends its minted rule', async () => {
  seedRules();
  server.once('GET', `${JOBS}/job-1`, { status: 404 });
  const { result: r } = mount();
  act(() => { r.current.setSheet({ mode: 'addRuleConfirm', pattern: '  COLES  ', categoryId: 'groceries', budgetExcluded: true }); });
  await act(async () => { await r.current.fileCharges(NEW_RULE, { matched: 999 }); });
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  expect(r.current.applyRulesJob?.status).toBe('failed');

  let retried: FilingResult | null = null;
  await act(async () => { retried = await r.current.retryApplyRulesJob(); });
  // The retry starts a fresh job (the fake server mints job-2), which then succeeds.
  server.seed(`${JOBS}/job-2`, job({ jobId: 'job-2', status: 'succeeded', createdRule: MINTED } as Partial<ApplyRulesJob>));
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });

  expect(retried).toEqual({ status: 'background' });
  expect(posts(JOBS)).toHaveLength(2);
  expect(posts(JOBS)[1].body).toEqual({ rule: { value: 'COLES', categoryId: 'groceries', budgetExcluded: true } });
  expect(rules().map((rule) => [rule.id, rule.isNew])).toEqual([['r-new', true], ['r-old', false]]);
});

// [A13] (P0) The sheets' preview effect and the lock subscription hold on to these callbacks, so
// they must keep their identity across a toast, a sheet change and job progress.
it('[A13] keeps previewFiling, fileCharges and retryApplyRulesJob stable across redraws', async () => {
  const { result: r } = mount();
  const first = { preview: r.current.previewFiling, file: r.current.fileCharges, retry: r.current.retryApplyRulesJob };

  act(() => { r.current.showToast('hi'); });
  act(() => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, { matched: 999 }); });
  server.seed(`${JOBS}/job-1`, job({ matched: 10, attempted: 5 }));
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  expect(r.current.applyRulesJob?.matched).toBe(10);

  expect(r.current.previewFiling).toBe(first.preview);
  expect(r.current.fileCharges).toBe(first.file);
  expect(r.current.retryApplyRulesJob).toBe(first.retry);
});

// [A14] (P0) A lock (after many redraws) stops polling, drops the job view and releases the lock.
it('[A14] stops polling, clears the job and frees the lock on a Face ID lock', async () => {
  const { result: r } = mount();
  // A confirm sheet stays open through a lock (only the sweep sheet is closed), so the job view
  // must be dropped by the lock itself, not by the dismiss.
  act(() => { r.current.setSheet({ mode: 'fileByShopConfirm', group: GROUP, categoryId: 'groceries' }); });
  act(() => { r.current.showToast('redraw'); });
  await act(async () => { await r.current.fileCharges(SHOP, { matched: 999 }); });
  server.seed(`${JOBS}/job-1`, job());
  await act(async () => { await jest.advanceTimersByTimeAsync(3000); });
  const pollsBefore = polls();
  expect(pollsBefore).toBeGreaterThan(0);

  act(() => { setAuthStatus('locked'); });
  await act(async () => { await jest.advanceTimersByTimeAsync(20000); });

  expect(r.current.applyRulesJob).toBeNull();
  expect(polls()).toBe(pollsBefore);
  act(() => { setAuthStatus('authed'); });
  server.seed(APPLY_RULES, report());
  let after: FilingResult | null = null;
  await act(async () => { after = await r.current.fileCharges(SWEEP, { now: true }); });
  expect(after).toEqual({ status: 'filed', report: expect.objectContaining({ matched: 5 }) });
});

// [A15] (P0) A preview or direct run settling after sign-out paints nothing and reports a failure.
it('[A15] drops a preview and a direct run that settle after sign-out', async () => {
  seedRules();
  server.once('POST', APPLY_RULES, { body: report({ dryRun: true }) });
  server.once('POST', APPLY_RULES, { body: report({ createdRule: MINTED }) });
  const pending = server.hold(APPLY_RULES);   // the preview and the commit both stay in flight
  const r = mount().result;

  let previewing!: Promise<FilingResult>;
  let filing!: Promise<FilingResult>;
  act(() => { previewing = r.current.previewFiling(SHOP); });
  act(() => { filing = r.current.fileCharges(NEW_RULE, { now: true }); });
  act(() => { setAuthStatus('anon'); });
  seedRules();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  let previewResult: FilingResult | null = null;
  let fileResult: FilingResult | null = null;
  await act(async () => {
    pending.release();
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
  const { result: r, unmount } = mount();
  act(() => { r.current.setSheet({ mode: 'applyRules' }); });
  await act(async () => { await r.current.fileCharges(SWEEP, { matched: 999 }); });

  unmount();
  await act(async () => { await jest.advanceTimersByTimeAsync(20000); });
  expect(polls()).toBe(0);
});
