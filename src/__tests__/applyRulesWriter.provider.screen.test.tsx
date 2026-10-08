// WHIT-508 — the two context actions behind the "Apply my rules" sheet.
//
// The write is unusual for this codebase: the server has ALREADY committed by the time it answers,
// and it reports exactly which rows landed. So there is no optimistic write and no rollback — the
// job is reconciling the caches with a report that may only partly match the plan.
//
// The properties that carry real risk:
//   - a FAILED write is an UNKNOWN outcome, not "nothing happened" — the server writes row by row,
//     so an abort can leave up to 300 charges filed while the badge (5min staleTime) shows the old
//     number. It must still refresh.
//   - the uncategorized feed is TRIMMED to page 1 and invalidated, never reset: reset drops the
//     data, so the tab blanks to a cold spinner right after a successful bulk file.
//   - ['transactions'] is never invalidated (the documented InfiniteData storm).
//   - `vanished` rows are removed from the caches, or a deleted charge lingers as a phantom.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext, APPLY_RULES_MAX_WRITES } from '../context';
import type { FilingResult, FilingTarget } from '../context';
import type { Transaction } from '../types';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, seedTransactionsPages } from './support/transactionsCache';

// A live miniature auth store (the sessionGuardRollbacks harness), so the tests below can end the
// session or lock the app mid-run and see the provider react for real.
jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { filedReport as report } from './support/applyRulesReport';
import { colesTxn as txn } from './factory';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const SWEEP: FilingTarget = { kind: 'sweep' };
const FAILED: FilingResult = { status: 'failed', background: false };

const server = installFakeServer();
const APPLY_RULES = '/transactions/uncategorized/apply-rules';

/** Read a named list cache back as a flat list of rows. */
function rowsIn(key: 'transactions' | 'uncategorizedFeed'): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>([key]);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

beforeEach(() => { queryClient.clear(); resetAuth(); });
afterEach(() => { queryClient.clear(); });

// --- the successful write -----------------------------------------------------

it('patches every filed row into all three list caches, by id', async () => {
  // Each row lives in ONE cache only, so a patch that reached just the feed would still fail here.
  seedTransactionsCache(queryClient, [txn(), txn({ transaction_id: 'untouched' })]);
  queryClient.setQueryData(['uncategorizedFeed'],
    { pages: [{ transactions: [txn({ transaction_id: 'deep' })], nextCursor: null }], pageParams: [undefined] });
  queryClient.setQueryData(['transactionsRecent'], [txn({ transaction_id: 'recent' })]);
  server.seed(APPLY_RULES, report({
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
  server.seed(APPLY_RULES, report({ filed: [], vanished: ['gone'] }));

  const result = mount();
  await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

  expect(rowsIn('transactions').map((r) => r.transaction_id)).toEqual(['t1']);
  expect(queryClient.getQueryData<Transaction[]>(['transactionsRecent'])).toEqual([]);
});

it('invalidates the server-derived reads but never the transactions feed', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.seed(APPLY_RULES, report());
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
  server.seed(APPLY_RULES, report({ filed: [] }));

  const result = mount();
  await act(async () => { await result.current.fileCharges(SWEEP, { now: true }); });

  const data = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(['uncategorizedFeed']);
  expect(data!.pages).toHaveLength(1);
  expect(data!.pageParams).toHaveLength(1);
  expect(rowsIn('uncategorizedFeed').map((r) => r.transaction_id)).toEqual(['p1']); // not blanked
});

it('returns the server report so the sheet can offer the next round', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.seed(APPLY_RULES, report({ remaining: 339 }));

  const result = mount();
  let returned: FilingResult | null = null;
  await act(async () => { returned = await result.current.fileCharges(SWEEP, { now: true }); });

  expect(returned).toEqual({ status: 'filed', report: expect.objectContaining({ remaining: 339 }) });
});

// --- the failure path (the blocker this card's review caught) -----------------

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

it('treats an offline write the same as a failed one', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.once('POST', APPLY_RULES, 'dropped');

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let returned: FilingResult | null = null;
  await act(async () => { returned = await result.current.fileCharges(SWEEP, { now: true }); });

  expect(returned).toEqual(FAILED);
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// --- the preview --------------------------------------------------------------

it('previews with dryRun true and writes nothing', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.seed(APPLY_RULES, report({ dryRun: true, filed: [] }));

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

it('returns null when the preview fails, without touching the caches', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  server.fail(APPLY_RULES, 502);

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let returned: FilingResult | null = null;
  await act(async () => { returned = await result.current.previewFiling(SWEEP); });

  expect(returned).toEqual(FAILED);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// --- session safety -----------------------------------------------------------

// WHIT-282: a run settling after a sign-out must not paint the next session's caches. Fail-on-
// revert: drop the post-await epoch check and the signed-out session gets the old account's rows.
it('bails without writing when the user signs out mid-write', async () => {
  server.once('POST', APPLY_RULES, { body: report({ filed: [{ id: 't1', category: 'groceries' }] }) });
  const pending = server.hold(APPLY_RULES);
  const result = mount();

  let returned: FilingResult | null = null;
  await act(async () => {
    const inFlight = result.current.fileCharges(SWEEP, { now: true });
    setAuthStatus('anon');                                   // sign-out bumps the session epoch
    seedTransactionsCache(queryClient, [txn()]);             // the next session's data
    pending.release();
    returned = await inFlight;
  });

  expect(returned).toEqual(FAILED);
  expect(rowsIn('transactions')[0].category).toBeNull();     // the late report never landed
});

it('bails without painting when the preview settles after a sign-out', async () => {
  server.once('POST', APPLY_RULES, { body: report({ dryRun: true }) });
  const pending = server.hold(APPLY_RULES);
  const result = mount();

  let returned: FilingResult | null = null;
  await act(async () => {
    const inFlight = result.current.previewFiling(SWEEP);
    setAuthStatus('anon');
    pending.release();
    returned = await inFlight;
  });

  expect(returned).toEqual(FAILED);
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

// --- [A52] WHIT-508: a row someone else filed is NOT a row that disappeared ----

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
  server.seed(APPLY_RULES, report({
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
