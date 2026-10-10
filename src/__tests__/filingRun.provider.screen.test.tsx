// WHIT-629 — one filing run through the app's data context.
//
// A sheet says what to file (a FilingTarget) and how many charges the preview matched; the context
// picks "file now" or "background job" and hands back one FilingResult. These tests prove the
// choice lives in the context, not the sheet, and that every path answers in the same shape; that
// the caches are reconciled with whatever the server reports (WHIT-508); that only one run happens
// at a time; and that a run settling after a lock or sign-out paints nothing.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { ApplyRulesJob, ApplyRulesResult, FilingResult, FilingTarget } from '../context';
import { useFilingRun } from '../filingRun';
import { runOptimisticSave, type SaveSteps } from '../optimisticSave';
import type { TransactionSearchResult, UncategorizedMerchantGroup } from '../api';
import type { Transaction } from '../types';
import type { Rule } from '../model';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, seedTransactionsPages, readTransactionsCache } from './support/transactionsCache';

// A live miniature auth store, so the tests below can end the session or lock the app mid-run and
// see the provider react for real.
jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { applyRulesReport, filedReport } from './support/applyRulesReport';
import { GROCERIES } from './support/categories';
import { colesTxn as txn, stevenTxn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
const APPLY_RULES = '/transactions/uncategorized/apply-rules';
const JOBS = `${APPLY_RULES}/jobs`;
const posts = (path: string) => server.sent('POST', path);

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 999,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
const SWEEP: FilingTarget = { kind: 'sweep' };
const FAILED: FilingResult = { status: 'failed', background: false };

function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }

/** Read a named list cache back as a flat list of rows. */
function rowsIn(key: 'transactions' | 'uncategorizedFeed'): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>([key]);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}

beforeEach(() => { queryClient.clear(); resetAuth(); });
afterEach(() => { queryClient.clear(); });

describe('now or background job', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  const report = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
    dryRun: false, rulesConsidered: 1, unfiled: 999, matched: 999, byCategory: { groceries: 300 }, remaining: 699,
    ...over,
  });

  it('sends a shop run over 300 charges to a background job and says so', async () => {
    const r = mount();
    let result: FilingResult | null = null;
    await act(async () => { result = await r.current.fileCharges(SHOP, { matched: 999 }); });

    expect(result).toEqual({ status: 'background' });
    expect(server.requests()).toContainEqual({ method: 'POST', path: JOBS, body: { rule: { value: 'coles', categoryId: 'groceries' } } });
    expect(posts(APPLY_RULES)).toHaveLength(0);
    expect(r.current.applyRulesJob?.status).toBe('running');
  });

  it('files the first 300 now, even over the cap, when the user picks "file up to 300"', async () => {
    server.seed(APPLY_RULES, report());

    const r = mount();
    let result: FilingResult | null = null;
    await act(async () => { result = await r.current.fileCharges(SWEEP, { matched: 999, now: true }); });

    expect(result).toEqual({ status: 'filed', report: expect.objectContaining({ matched: 999 }) });
    expect(posts(APPLY_RULES)).toHaveLength(1);
    expect(posts(APPLY_RULES)[0].body).toMatchObject({ dryRun: false });
    expect(posts(APPLY_RULES)[0].body).not.toHaveProperty('rule');
    expect(posts(JOBS)).toHaveLength(0);
  });

  it('reports a rule clash with where it came from: filing now vs starting a job', async () => {
    server.fail(APPLY_RULES, 409);
    server.fail(JOBS, 409);

    const r = mount();
    let now: FilingResult | null = null;
    let background: FilingResult | null = null;
    await act(async () => { now = await r.current.fileCharges(SHOP, { matched: 5 }); });
    await act(async () => { background = await r.current.fileCharges(SHOP, { matched: 999 }); });

    expect(now).toEqual({ status: 'clash', error: expect.any(ApiError), background: false });
    expect(background).toEqual({ status: 'clash', error: expect.any(ApiError), background: true });
  });
});

// WHIT-629 QA: what the merge of three copies into one could quietly lose — the sweep never
// clashes, only a new rule gets its NEW badge, the one-run-at-a-time lock, the stable identities
// the sheets rely on, and the sign-out teardown.
describe('edges of one filing run', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

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

  function seedRules() { queryClient.setQueryData<Rule[]>(['rules'], [EXISTING_RULE]); }
  function rules() { return queryClient.getQueryData<Rule[]>(['rules']) ?? []; }

  // [A1] (P0) The plain sweep carries no inline rule, so a 409 is a plain failure on every path.
  it('[A1] turns a sweep 409 into a plain failure on preview, file now and start job', async () => {
    server.fail(APPLY_RULES, 409);
    server.fail(JOBS, 409);
    const r = mount();

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
    const r = mount();
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
    const r = mount();
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
    const r = mount();
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
    const r = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await r.current.fileCharges(SHOP, { matched: 5 }); });

    expect(rules().map((rule) => rule.id)).toEqual(['r-old']);
    expect(invalidatedKeys(spy)).toContain('rules');
    spy.mockRestore();
  });

  // [A9] (P0) One run at a time: a job can't start while a direct run is still in flight.
  it('[A9] refuses to start a background job while a direct run is in flight', async () => {
    server.once('POST', APPLY_RULES, { body: report() });
    const pending = server.hold(APPLY_RULES);
    const r = mount();

    let first!: Promise<FilingResult>;
    act(() => { first = r.current.fileCharges(SWEEP, { now: true }); });
    let second: FilingResult | null = null;
    await act(async () => { second = await r.current.fileCharges(SHOP, { matched: 999 }); });
    expect(second).toEqual({ status: 'failed', background: true });
    expect(posts(JOBS)).toHaveLength(0);

    await act(async () => { pending.release(); await first; });
  });

  // [A13] (P0) The sheets' preview effect and the lock subscription hold on to these callbacks, so
  // they must keep their identity across a toast, a sheet change and job progress.
  it('[A13] keeps previewFiling, fileCharges and retryApplyRulesJob stable across redraws', async () => {
    const r = mount();
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

  // [A15] (P0) A preview or direct run settling after sign-out paints nothing and reports a failure.
  it('[A15] drops a preview and a direct run that settle after sign-out', async () => {
    seedRules();
    server.once('POST', APPLY_RULES, { body: report({ dryRun: true }) });
    server.once('POST', APPLY_RULES, { body: report({ createdRule: MINTED }) });
    const pending = server.hold(APPLY_RULES);   // the preview and the commit both stay in flight
    const r = mount();

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
});

// WHIT-508: the server has ALREADY committed by the time it answers, and reports exactly which rows
// landed. So there is no optimistic write and no rollback — the job is reconciling the caches with
// a report that may only partly match the plan.
describe('reconciling the caches with the report', () => {
  it('patches every filed row into all three list caches, by id', async () => {
    // Each row lives in ONE cache only, so a patch that reached just the feed would still fail here.
    seedTransactionsCache(queryClient, [txn(), txn({ transaction_id: 'untouched' })]);
    queryClient.setQueryData(['uncategorizedFeed'],
      { pages: [{ transactions: [txn({ transaction_id: 'deep' })], nextCursor: null }], pageParams: [undefined] });
    queryClient.setQueryData(['transactionsRecent'], [txn({ transaction_id: 'recent' })]);
    server.seed(APPLY_RULES, filedReport({
      filed: [{ id: 't1', category: 'groceries' }, { id: 'deep', category: 'fuel' }, { id: 'recent', category: 'coffee' }],
    }));

    const result = mount();
    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    const byId = new Map([...rowsIn('transactions'), ...rowsIn('uncategorizedFeed'),
      ...(queryClient.getQueryData<Transaction[]>(['transactionsRecent']) ?? [])]
      .map((row) => [row.transaction_id, row.category]));
    expect(byId.get('t1')).toBe('groceries');
    expect(byId.get('deep')).toBe('fuel');
    expect(byId.get('recent')).toBe('coffee');
    expect(byId.get('untouched')).toBeNull();   // not in `filed` → never touched
  });

  // A row deleted server-side mid-run. The uncategorized feed is refetched anyway, so the removal
  // only actually matters in the OTHER two caches — assert exactly those, or the filter is untested.
  it('removes vanished rows from the feed and the recent window', async () => {
    seedTransactionsCache(queryClient, [txn(), txn({ transaction_id: 'gone' })]);
    queryClient.setQueryData(['transactionsRecent'], [txn({ transaction_id: 'gone' })]);
    server.seed(APPLY_RULES, filedReport({ filed: [], vanished: ['gone'] }));

    const result = mount();
    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    expect(rowsIn('transactions').map((r) => r.transaction_id)).toEqual(['t1']);
    expect(queryClient.getQueryData<Transaction[]>(['transactionsRecent'])).toEqual([]);
  });

  it('invalidates the server-derived reads but never the transactions feed', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    server.seed(APPLY_RULES, filedReport());
    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    const keys = invalidatedKeys(spy);
    // `categories` is in the list for a specific reason: the reconcile writes the SERVER's category
    // id onto the row, and a row whose id isn't in the client's taxonomy still counts as unfiled —
    // so a category created elsewhere during the run would leave its charges in the Uncategorized
    // list while the badge dropped. Fail-on-revert: drop that invalidation and this reddens.
    expect(keys).toEqual(expect.arrayContaining(
      ['uncategorizedCount', 'budgets', 'breakdown', 'budgetTransactions', 'categoryTransactions',
        'uncategorizedFeed', 'categories']));
    // Fail-on-revert for the documented storm rule: an InfiniteData invalidate refetches EVERY
    // loaded page sequentially, and the patch above already wrote the change into this cache.
    expect(keys).not.toContain('transactions');
    spy.mockRestore();
  });

  // The trim-not-reset decision, pinned. Fail-on-revert: swap the trim + invalidate for
  // resetQueries and page 1's rows vanish, so the tab cold-loads to a blank right after a
  // successful bulk file.
  it('trims the uncategorized feed to page 1 and keeps its rows on screen', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    queryClient.setQueryData(['uncategorizedFeed'], {
      pages: [
        { transactions: [txn({ transaction_id: 'p1' })], nextCursor: 'c1' },
        { transactions: [txn({ transaction_id: 'p2' })], nextCursor: 'c2' },
        { transactions: [txn({ transaction_id: 'p3' })], nextCursor: null },
      ],
      pageParams: [undefined, 'c1', 'c2'],
    });
    server.seed(APPLY_RULES, filedReport({ filed: [] }));

    const result = mount();
    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    const data = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(['uncategorizedFeed']);
    expect(data!.pages).toHaveLength(1);
    expect(data!.pageParams).toHaveLength(1);
    expect(rowsIn('uncategorizedFeed').map((r) => r.transaction_id)).toEqual(['p1']); // not blanked
  });

  // A dropped connection mid-write is an UNKNOWN outcome: the server commits row by row, so up to
  // APPLY_RULES_MAX_WRITES charges may already be filed. The count query has a 5-minute staleTime,
  // so without this refresh the badge, list and budgets keep the old numbers until a manual pull.
  // Fail-on-revert: delete the refresh from the catch and this reddens.
  it('still refreshes the caches when the write fails', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    seedTransactionsPages(queryClient, [{ transactions: [txn()], nextCursor: 'c1' }]);
    queryClient.setQueryData(['uncategorizedFeed'], {
      pages: [{ transactions: [txn()], nextCursor: 'c1' }, { transactions: [], nextCursor: null }],
      pageParams: [undefined, 'c1'],
    });
    server.fail(APPLY_RULES, 502);

    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    let returned: FilingResult | null = null;
    await act(async () => { returned = await result.current.fileCharges(SWEEP, { now: true }); });

    expect(returned).toEqual(FAILED);
    expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['uncategorizedCount', 'budgets', 'uncategorizedFeed']));
    expect(queryClient.getQueryData<{ pages: unknown[] }>(['uncategorizedFeed'])!.pages).toHaveLength(1);
    spy.mockRestore();
  });

  it('previews with dryRun true and writes nothing', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    server.seed(APPLY_RULES, filedReport({ dryRun: true, filed: [] }));

    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    let returned: FilingResult | null = null;
    await act(async () => { returned = await result.current.previewFiling(SWEEP); });

    expect(server.requests()).toContainEqual({ method: 'POST', path: APPLY_RULES, body: { dryRun: true } });
    expect(returned).toEqual({ status: 'filed', report: expect.objectContaining({ dryRun: true }) });
    expect(spy).not.toHaveBeenCalled();                    // a preview reconciles nothing
    expect(rowsIn('transactions')[0].category).toBeNull(); // ...and touches no row
    spy.mockRestore();
  });

  // M4: the WHIT-268 privacy shield unmounts the whole overlay layer on a LOCK, destroying the
  // sheet's local state — but the context-held `sheet` survives, so on unlock it would remount and
  // fire a SECOND whole-history scan with no memory of the run behind it. Drop it instead.
  // Fail-on-revert: remove the setSheet line from the auth subscriber and the sheet is still open.
  it('closes the apply-rules sheet on a Face ID lock', () => {
    const result = mount();
    act(() => { result.current.setSheet({ mode: 'applyRules' }); });

    act(() => { setAuthStatus('locked'); });

    expect(result.current.sheet).toBeNull();
  });

  // The counterpart: a lock must not close the sheets WHIT-277 exists to preserve, and a plain
  // re-broadcast of 'authed' must not close anything at all.
  it('leaves other sheets alone on a lock, and every sheet alone on an authed re-broadcast', () => {
    const result = mount();
    act(() => { result.current.setSheet({ mode: 'addrule' }); });
    act(() => { setAuthStatus('locked'); });
    expect(result.current.sheet).toEqual({ mode: 'addrule' });

    setAuthStatusQuietly('authed');
    act(() => { result.current.setSheet({ mode: 'applyRules' }); });
    act(() => { setAuthStatus('authed') });
    expect(result.current.sheet).toEqual({ mode: 'applyRules' });
  });

  // `vanished` and `alreadyFiled` both mean "we did not write this one", and they are one word
  // apart in the response — but only `vanished` rows are gone server-side. An alreadyFiled row is
  // sitting on screen holding the category the user just tapped, so dropping it from the caches
  // deletes a charge she can see, and the invalidation does not bring the general feed back.
  // Fail-on-revert: fold `result.alreadyFiled` into the `vanished` Set -> red.
  it('keeps rows the user filed mid-run in the caches, with their own category', async () => {
    seedTransactionsCache(queryClient, [
      txn({ transaction_id: 'kept', category: 'coffee' }),   // her tap, already in the cache
      txn({ transaction_id: 'gone' }),
    ]);
    queryClient.setQueryData(['transactionsRecent'], [txn({ transaction_id: 'kept', category: 'coffee' })]);
    server.seed(APPLY_RULES, filedReport({
      filed: [], vanished: ['gone'], alreadyFiled: ['kept'],
    }));

    const result = mount();
    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    const rows = rowsIn('transactions');
    expect(rows.map((r) => r.transaction_id)).toEqual(['kept']);   // the vanished one went, this stayed
    // And it still holds HER category — the rule's target was never written, so neither is it here.
    expect(rows[0].category).toBe('coffee');
    expect(queryClient.getQueryData<Transaction[]>(['transactionsRecent'])).toHaveLength(1);
  });
});

// WHIT-508: a 639-charge sweep takes rounds, and a pull-to-refresh, a background sync or a
// hand-filed charge can land in the middle of any of them.
describe('runs and refreshes happening at the same time', () => {
  // The sheet stays open for minutes across several rounds, so a pull-to-refresh, a sync or a
  // hand-filed charge routinely lands while a run is in flight. The reconcile therefore has to be a
  // transform over WHATEVER is cached when the report arrives.
  // Fail-on-revert: snapshot the rows before the await (the rollback pattern every other writer in
  // this file uses) and write that snapshot back — the refreshed row vanishes and the hand-filed
  // one reverts to unfiled.
  it('reconciles against the rows present when the report lands, not a pre-call snapshot', async () => {
    seedTransactionsCache(queryClient, [txn({ transaction_id: 't1' })]);
    server.once('POST', APPLY_RULES, { body: filedReport({ filed: [{ id: 't1', category: 'groceries' }] }) });
    const pending = server.hold(APPLY_RULES);   // the run stays in flight until release()
    const result = mount();

    await act(async () => {
      const inFlight = result.current.fileCharges(SWEEP, { now: true });
      // mid-run: a refresh brings a charge the first read never had, and she files another by hand.
      seedTransactionsCache(queryClient, [
        txn({ transaction_id: 't1' }),
        txn({ transaction_id: 't2', category: 'fuel' }),
        txn({ transaction_id: 't3' }),
      ]);
      pending.release();
      await inFlight;
    });

    const rows = new Map(rowsIn('transactions').map((row) => [row.transaction_id, row.category]));
    expect(rows.size).toBe(3);
    expect(rows.get('t1')).toBe('groceries');   // the sweep's own row landed
    expect(rows.get('t2')).toBe('fuel');        // the hand-filed row was not reverted
    expect(rows.get('t3')).toBeNull();          // the newly-arrived row was not dropped
  });

  // Each round RE-PLANS from a fresh scan, so a row filed in round 1 can legitimately appear in
  // round 2's report again, and the server's order has nothing to do with the cache's.
  // Fail-on-revert: reconcile by array position instead of id and t1 comes back as Fuel — the exact
  // mistake applyCategoryToMany documents.
  it('converges across rounds when a later report re-reports rows, in its own order', async () => {
    seedTransactionsCache(queryClient, [
      txn({ transaction_id: 't1' }), txn({ transaction_id: 't2' }), txn({ transaction_id: 't3' }),
    ]);
    const result = mount();

    server.once('POST', APPLY_RULES, { body: filedReport({ filed: [{ id: 't1', category: 'groceries' }], remaining: 2 }) });
    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    server.once('POST', APPLY_RULES, { body: filedReport({
      filed: [{ id: 't3', category: 'fuel' }, { id: 't1', category: 'groceries' }],
      vanished: ['t2'], remaining: 0,
    }) });
    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    expect(rowsIn('transactions').map((row) => [row.transaction_id, row.category]))
      .toEqual([['t1', 'groceries'], ['t3', 'fuel']]);
  });

  // "The preview writes nothing" has to include the cache's SHAPE. The existing preview test watches
  // invalidateQueries, which a trim (a plain setQueryData) walks straight past — so a preview that
  // dropped her loaded pages would pass it.
  // Fail-on-revert: call refreshAfterApplyRules() from previewRuleApplication → 3 pages become 1 and
  // the deeper rows disappear from under her while she reads the breakdown.
  it('leaves every loaded uncategorized page alone during a preview', async () => {
    queryClient.setQueryData(['uncategorizedFeed'], {
      pages: [
        { transactions: [txn({ transaction_id: 'p1' })], nextCursor: 'c1' },
        { transactions: [txn({ transaction_id: 'p2' })], nextCursor: 'c2' },
        { transactions: [txn({ transaction_id: 'p3' })], nextCursor: null },
      ],
      pageParams: [undefined, 'c1', 'c2'],
    });
    server.seed(APPLY_RULES, filedReport({ dryRun: true, filed: [] }));
    const result = mount();

    await act(async () => { await result.current.previewFiling(SWEEP); });

    const data = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(['uncategorizedFeed']);
    expect(data!.pages).toHaveLength(3);
    expect(data!.pageParams).toHaveLength(3);
    expect(rowsIn('uncategorizedFeed').map((row) => row.transaction_id)).toEqual(['p1', 'p2', 'p3']);
  });

  // The success path's epoch bail is pinned; the FAILURE path has its own, and it is the one that
  // fires when the sign-out itself is what killed the request. Refetching there would pull the
  // previous account's uncategorized count, budgets and feed into a session that has just ended.
  it('does not refresh the caches when a FAILING write lands after a sign-out', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    server.once('POST', APPLY_RULES, { status: 401 });
    const pending = server.hold(APPLY_RULES);
    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    let returned: FilingResult | null = null;
    await act(async () => {
      const inFlight = result.current.fileCharges(SWEEP, { now: true });
      setAuthStatus('anon');                            // sign-out bumps the session epoch
      pending.release();                                // the write then fails with a 401
      returned = await inFlight;
    });

    expect(returned).toEqual(FAILED);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // The sheet is dismissable while a write runs (the backdrop and drag handle belong to SheetHost),
  // and reopening mounts a fresh component with a fresh double-tap latch. If the latch lived only in
  // the sheet, that would start a SECOND 300-write run on top of the first.
  // Fail-on-revert: move the guard back into the component and this reddens.
  it('refuses a second run while one is still in flight', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    server.once('POST', APPLY_RULES, { body: filedReport() });
    const pending = server.hold(APPLY_RULES);
    const result = mount();

    let second: FilingResult | null = null;
    await act(async () => {
      const first = result.current.fileCharges(SWEEP, { now: true });
      second = await result.current.fileCharges(SWEEP, { now: true });   // as if reopened and tapped again
      pending.release();
      await first;
    });

    expect(second).toEqual(FAILED);
    expect(posts(APPLY_RULES)).toHaveLength(1);
  });

  // A failed run must release the latch too, or one dropped connection locks her out permanently.
  it('releases the latch after a failed run', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    server.once('POST', APPLY_RULES, { status: 502 });
    const result = mount();
    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    server.once('POST', APPLY_RULES, { body: filedReport() });
    let retried: FilingResult | null = null;
    await act(async () => { retried = await result.current.fileCharges(SWEEP, { now: true }); });

    expect(retried).toEqual({ status: 'filed', report: expect.anything() });
  });
});

describe('a new rule filed now', () => {
  // Older server: no createdRule in the response → we can't optimistically place it, so fall back to
  // invalidating ['rules'] so the rule still lands on refetch. Fail-on-revert: drop the else branch and
  // ['rules'] is never refreshed → a minted rule the client can't see.
  it('falls back to invalidating ["rules"] when the server omits createdRule', async () => {
    seedTransactionsCache(queryClient, [txn()]);
    server.seed(APPLY_RULES, filedReport({ rulesConsidered: 1, createdRule: null }));

    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');
    await act(async () => { await result.current.fileCharges({ kind: 'newRule', pattern: 'COLES', categoryId: 'groceries', budgetExcluded: false }, { now: true }); });

    expect(invalidatedKeys(spy)).toContain('rules');
    spy.mockRestore();
  });
});

// WHIT-647: the filing preview and "file now" go through the shared save runner; whatever that
// runner decides about the session is final. Here the runner says "signed out" while the hook's own
// session stamp never moves — so only a filing run that really uses the runner drops the result.
describe('the shared save runner', () => {
  const runnerReport = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
    dryRun: false, rulesConsidered: 1, unfiled: 1, matched: 1, byCategory: { groceries: 1 },
    filed: [{ id: 't1', category: 'groceries' }], createdRule: null,
    ...over,
  });
  const UNFILED = { transaction_id: 't1', description: 'COLES 1234', amount: -10, category: null } as unknown as Transaction;

  it('drops the filing preview and "file now" when the save runner says the user signed out', async () => {
    let sameSession = false;
    const runSave = jest.fn(<R, T>(steps: SaveSteps<R, T>) => runOptimisticSave(() => sameSession, steps));
    const sessionEpoch = { current: 0 };
    seedTransactionsCache(queryClient, [UNFILED]);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    server.seed('/transactions/uncategorized/apply-rules', runnerReport());

    const { result } = renderHook(() => useFilingRun({
      sessionEpoch, runSave, prependMintedRule: jest.fn(), sheetOpen: true,
    } as Parameters<typeof useFilingRun>[0]));

    let preview: FilingResult | null = null;
    let now: FilingResult | null = null;
    await act(async () => { preview = await result.current.previewFiling(SHOP); });
    await act(async () => { now = await result.current.fileCharges(SHOP, { now: true }); });

    expect(preview).toEqual({ status: 'failed', background: false });
    expect(now).toEqual({ status: 'failed', background: false });
    expect(readTransactionsCache(queryClient)[0].category).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();

    // The one-run-at-a-time lock was released: once the runner says the session is live, "file now"
    // files and paints the row.
    sameSession = true;
    let again: FilingResult | null = null;
    await act(async () => { again = await result.current.fileCharges(SHOP, { now: true }); });
    expect(again).toEqual({ status: 'filed', report: runnerReport() });
    expect(readTransactionsCache(queryClient)[0].category).toBe('groceries');
  });
});

// WHIT-576: "Apply my rules" re-files rows SERVER-side, so a search result that holds them must
// both show the change at once and be re-asked.
describe('search results', () => {
  const SEARCH_KEY = ['transactionsSearch', 'uncategorized', 'steven'];

  beforeEach(() => {
    queryClient.setQueryData(['categories'], [{ ...GROCERIES }]);
    queryClient.setQueryData<TransactionSearchResult>(SEARCH_KEY, { transactions: [stevenTxn({ transaction_id: 'deep1' }), stevenTxn({ transaction_id: 'deep2' }), stevenTxn({ transaction_id: 'deep3' })], truncated: false, matchCount: 3, matchTotal: 0 });
  });

  it('[A10] apply-rules patches + invalidates the search result', async () => {
    server.seed('/transactions/uncategorized/apply-rules', {
      dryRun: false, rulesConsidered: 1, unfiled: 3, matched: 1, conflicted: 0, conflictedSamples: [],
      byCategory: { groceries: 1 }, byRule: [], skippedRules: [],
      filed: [{ id: 'deep1', category: 'groceries' }], vanished: ['deep2'], failed: [],
    });
    const result = mount();
    const spy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

    const rows = queryClient.getQueryData<TransactionSearchResult>(SEARCH_KEY)!.transactions;
    expect(rows.map((t) => [t.transaction_id, t.category])).toEqual([['deep1', 'groceries'], ['deep3', null]]);
    const invalidated = invalidatedKeys(spy);
    expect(invalidated).toContain('transactionsSearch');
    expect(queryClient.getQueryState(SEARCH_KEY)?.isInvalidated).toBe(true);
    spy.mockRestore();
  });
});
