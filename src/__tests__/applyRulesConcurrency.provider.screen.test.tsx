// WHIT-508 — apply-rules reconcile under things happening AT THE SAME TIME.
//
// applyRulesWriter.provider.screen.test.tsx pins one run against a still cache. A 639-charge sweep
// is not that: it takes rounds, and a pull-to-refresh, a background sync or a hand-filed charge can
// land in the middle of any of them. The properties below:
//   [A21] the reconcile reads the cache when the report LANDS, so a refresh (or a manual file)
//         that arrived mid-run is not rolled back by it.
//   [A22] rounds converge: a later report that re-reports rows already filed, in an order that has
//         nothing to do with the cache's, must still land by id.
//   [A23] a preview leaves the loaded pages alone — including their COUNT, which an invalidate-
//         and-trim would quietly halve while she is reading the breakdown.
//   [A24] a write that FAILS after a sign-out must not refresh the next session's caches.
//   [A25] dismissing the sheet mid-write cannot start a second concurrent run.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, ApplyRulesResult } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (status: typeof mockStatus) => {
  mockStatus = status;
  mockListeners.forEach((listener) => listener());
};
jest.mock('../api');
jest.mock('../auth', () => ({
  getStatus: () => mockStatus,
  subscribe: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
  ...over,
});

const report = (over: Partial<ApplyRulesResult> = {}): ApplyRulesResult => ({
  dryRun: false, rulesConsidered: 2, unfiled: 3, matched: 1, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 1 }, byRule: [], skippedRules: [],
  filed: [{ id: 't1', category: 'groceries' }], vanished: [], failed: [], remaining: 0,
  ...over,
});

function rowsIn(key: 'transactions' | 'uncategorizedFeed'): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>([key]);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}

const mount = () => renderHook(() => useAppContext(), { wrapper }).result;

/** A promise the test settles itself, so the run is genuinely in flight while other things happen. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});   // the provider owns the real handler; this only silences the warning
  return { promise, resolve, reject };
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); mockStatus = 'authed'; });
afterEach(() => { queryClient.clear(); });

// --- a refresh landing mid-run ------------------------------------------------

// The sheet stays open for minutes across several rounds, so a pull-to-refresh, a sync or a
// hand-filed charge routinely lands while a run is in flight. The reconcile therefore has to be a
// transform over WHATEVER is cached when the report arrives.
// Fail-on-revert: snapshot the rows before the await (the rollback pattern every other writer in
// this file uses) and write that snapshot back — the refreshed row vanishes and the hand-filed
// one reverts to unfiled.
it('reconciles against the rows present when the report lands, not a pre-call snapshot', async () => {
  seedTransactionsCache(queryClient, [txn({ transaction_id: 't1' })]);
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();

  await act(async () => {
    const inFlight = result.current.applyRulesToHistory();
    // mid-run: a refresh brings a charge the first read never had, and she files another by hand.
    seedTransactionsCache(queryClient, [
      txn({ transaction_id: 't1' }),
      txn({ transaction_id: 't2', category: 'fuel' }),
      txn({ transaction_id: 't3' }),
    ]);
    pending.resolve(report({ filed: [{ id: 't1', category: 'groceries' }] }));
    await inFlight;
  });

  const rows = new Map(rowsIn('transactions').map((row) => [row.transaction_id, row.category]));
  expect(rows.size).toBe(3);
  expect(rows.get('t1')).toBe('groceries');   // the sweep's own row landed
  expect(rows.get('t2')).toBe('fuel');        // the hand-filed row was not reverted
  expect(rows.get('t3')).toBeNull();          // the newly-arrived row was not dropped
});

// --- rounds overlapping -------------------------------------------------------

// Each round RE-PLANS from a fresh scan, so a row filed in round 1 can legitimately appear in
// round 2's report again, and the server's order has nothing to do with the cache's.
// Fail-on-revert: reconcile by array position instead of id and t1 comes back as Fuel — the exact
// mistake applyCategoryToMany documents.
it('converges across rounds when a later report re-reports rows, in its own order', async () => {
  seedTransactionsCache(queryClient, [
    txn({ transaction_id: 't1' }), txn({ transaction_id: 't2' }), txn({ transaction_id: 't3' }),
  ]);
  const result = mount();

  mockApi.applyRulesToUncategorized.mockResolvedValueOnce(
    report({ filed: [{ id: 't1', category: 'groceries' }], remaining: 2 }));
  await act(async () => { await result.current.applyRulesToHistory(); });

  mockApi.applyRulesToUncategorized.mockResolvedValueOnce(report({
    filed: [{ id: 't3', category: 'fuel' }, { id: 't1', category: 'groceries' }],
    vanished: ['t2'], remaining: 0,
  }));
  await act(async () => { await result.current.applyRulesToHistory(); });

  expect(rowsIn('transactions').map((row) => [row.transaction_id, row.category]))
    .toEqual([['t1', 'groceries'], ['t3', 'fuel']]);
});

// --- the preview really writes nothing ----------------------------------------

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
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ dryRun: true, filed: [] }));
  const result = mount();

  await act(async () => { await result.current.previewRuleApplication(); });

  const data = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(['uncategorizedFeed']);
  expect(data!.pages).toHaveLength(3);
  expect(data!.pageParams).toHaveLength(3);
  expect(rowsIn('uncategorizedFeed').map((row) => row.transaction_id)).toEqual(['p1', 'p2', 'p3']);
});

// --- a failure landing after sign-out -----------------------------------------

// The success path's epoch bail is pinned; the FAILURE path has its own, and it is the one that
// fires when the sign-out itself is what killed the request. Refetching there would pull the
// previous account's uncategorized count, budgets and feed into a session that has just ended.
it('does not refresh the caches when a FAILING write lands after a sign-out', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  let returned: ApplyRulesResult | null = report();
  await act(async () => {
    const inFlight = result.current.applyRulesToHistory();
    mockSetStatus('anon');                            // sign-out bumps the session epoch
    pending.reject(new Error('API error: 401'));
    returned = await inFlight;
  });

  expect(returned).toBeNull();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// --- one run at a time --------------------------------------------------------

// The sheet is dismissable while a write runs (the backdrop and drag handle belong to SheetHost),
// and reopening mounts a fresh component with a fresh double-tap latch. If the latch lived only in
// the sheet, that would start a SECOND 300-write run on top of the first.
// Fail-on-revert: move the guard back into the component and this reddens.
it('refuses a second run while one is still in flight', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();

  let second: ApplyRulesResult | null = report();
  await act(async () => {
    const first = result.current.applyRulesToHistory();
    second = await result.current.applyRulesToHistory();   // as if reopened and tapped again
    pending.resolve(report());
    await first;
  });

  expect(second).toBeNull();
  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledTimes(1);
});

// ...and the latch must release, or the feature is dead after one round.
it('allows the next round once the previous one has settled', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());
  const result = mount();

  await act(async () => { await result.current.applyRulesToHistory(); });
  await act(async () => { await result.current.applyRulesToHistory(); });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledTimes(2);
});

// A failed run must release the latch too, or one dropped connection locks her out permanently.
it('releases the latch after a failed run', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValueOnce(new Error('API error: 502'));
  const result = mount();
  await act(async () => { await result.current.applyRulesToHistory(); });

  mockApi.applyRulesToUncategorized.mockResolvedValueOnce(report());
  let retried: ApplyRulesResult | null = null;
  await act(async () => { retried = await result.current.applyRulesToHistory(); });

  expect(retried).not.toBeNull();
});
