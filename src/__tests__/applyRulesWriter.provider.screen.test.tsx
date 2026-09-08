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
import { AppProvider, useAppContext } from '../context';
import type { Transaction, ApplyRulesResult } from '../context';
import { queryClient } from '../queryClient';
import { seedTransactionsCache, seedTransactionsPages } from './support/transactionsCache';

// A live miniature auth store (the sessionGuardRollbacks harness), so the tests below can end the
// session or lock the app mid-run and see the provider react for real.
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

function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}

/** Read a named list cache back as a flat list of rows. */
function rowsIn(key: 'transactions' | 'uncategorizedFeed'): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>([key]);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}

function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); mockStatus = 'authed'; });
afterEach(() => { queryClient.clear(); });

/** A promise the test resolves itself, so the action is genuinely in flight while the session changes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// --- the successful write -----------------------------------------------------

it('patches every filed row into all three list caches, by id', async () => {
  // Each row lives in ONE cache only, so a patch that reached just the feed would still fail here.
  seedTransactionsCache(queryClient, [txn(), txn({ transaction_id: 'untouched' })]);
  queryClient.setQueryData(['uncategorizedFeed'],
    { pages: [{ transactions: [txn({ transaction_id: 'deep' })], nextCursor: null }], pageParams: [undefined] });
  queryClient.setQueryData(['transactionsRecent'], [txn({ transaction_id: 'recent' })]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({
    filed: [{ id: 't1', category: 'groceries' }, { id: 'deep', category: 'fuel' }, { id: 'recent', category: 'coffee' }],
  }));

  const result = mount();
  await act(async () => { await result.current.applyRulesToHistory(); });

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
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ filed: [], vanished: ['gone'] }));

  const result = mount();
  await act(async () => { await result.current.applyRulesToHistory(); });

  expect(rowsIn('transactions').map((r) => r.transaction_id)).toEqual(['t1']);
  expect(queryClient.getQueryData<Transaction[]>(['transactionsRecent'])).toEqual([]);
});

it('invalidates the server-derived reads but never the transactions feed', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.applyRulesToHistory(); });

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
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ filed: [] }));

  const result = mount();
  await act(async () => { await result.current.applyRulesToHistory(); });

  const data = queryClient.getQueryData<{ pages: unknown[]; pageParams: unknown[] }>(['uncategorizedFeed']);
  expect(data!.pages).toHaveLength(1);
  expect(data!.pageParams).toHaveLength(1);
  expect(rowsIn('uncategorizedFeed').map((r) => r.transaction_id)).toEqual(['p1']); // not blanked
});

it('returns the server report so the sheet can offer the next round', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ remaining: 339 }));

  const result = mount();
  let returned: ApplyRulesResult | null = null;
  await act(async () => { returned = await result.current.applyRulesToHistory(); });

  expect(returned!.remaining).toBe(339);
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
  mockApi.applyRulesToUncategorized.mockRejectedValue(new Error('API error: 502'));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let returned: ApplyRulesResult | null = report();
  await act(async () => { returned = await result.current.applyRulesToHistory(); });

  expect(returned).toBeNull();
  expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['uncategorizedCount', 'budgets', 'uncategorizedFeed']));
  expect(queryClient.getQueryData<{ pages: unknown[] }>(['uncategorizedFeed'])!.pages).toHaveLength(1);
  spy.mockRestore();
});

it('treats an offline write the same as a failed one', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new TypeError('Network request failed'));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let returned: ApplyRulesResult | null = report();
  await act(async () => { returned = await result.current.applyRulesToHistory(); });

  expect(returned).toBeNull();
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// --- the preview --------------------------------------------------------------

it('previews with dryRun true and writes nothing', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ dryRun: true, filed: [] }));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let returned: ApplyRulesResult | null = null;
  await act(async () => { returned = await result.current.previewRuleApplication(); });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(true);
  expect(returned!.dryRun).toBe(true);
  expect(spy).not.toHaveBeenCalled();                    // a preview reconciles nothing
  expect(rowsIn('transactions')[0].category).toBeNull(); // ...and touches no row
  spy.mockRestore();
});

it('returns null when the preview fails, without touching the caches', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new Error('API error: 502'));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let returned: ApplyRulesResult | null = report();
  await act(async () => { returned = await result.current.previewRuleApplication(); });

  expect(returned).toBeNull();
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

// --- session safety -----------------------------------------------------------

// WHIT-282: a run settling after a sign-out must not paint the next session's caches. Fail-on-
// revert: drop the post-await epoch check and the signed-out session gets the old account's rows.
it('bails without writing when the user signs out mid-write', async () => {
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();

  let returned: ApplyRulesResult | null = report();
  await act(async () => {
    const inFlight = result.current.applyRulesToHistory();
    mockSetStatus('anon');                                   // sign-out bumps the session epoch
    seedTransactionsCache(queryClient, [txn()]);             // the next session's data
    pending.resolve(report({ filed: [{ id: 't1', category: 'groceries' }] }));
    returned = await inFlight;
  });

  expect(returned).toBeNull();
  expect(rowsIn('transactions')[0].category).toBeNull();     // the late report never landed
});

it('bails without painting when the preview settles after a sign-out', async () => {
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();

  let returned: ApplyRulesResult | null = report();
  await act(async () => {
    const inFlight = result.current.previewRuleApplication();
    mockSetStatus('anon');
    pending.resolve(report({ dryRun: true }));
    returned = await inFlight;
  });

  expect(returned).toBeNull();
});

// M4: the WHIT-268 privacy shield unmounts the whole overlay layer on a LOCK, destroying the
// sheet's local state — but the context-held `sheet` survives, so on unlock it would remount and
// fire a SECOND whole-history scan with no memory of the run behind it. Drop it instead.
// Fail-on-revert: remove the setSheet line from the auth subscriber and the sheet is still open.
it('closes the apply-rules sheet on a Face ID lock', () => {
  const result = mount();
  act(() => { result.current.setSheet({ mode: 'applyRules' }); });

  act(() => { mockSetStatus('locked'); });

  expect(result.current.sheet).toBeNull();
});

// The counterpart: a lock must not close the sheets WHIT-277 exists to preserve, and a plain
// re-broadcast of 'authed' must not close anything at all.
it('leaves other sheets alone on a lock, and every sheet alone on an authed re-broadcast', () => {
  const result = mount();
  act(() => { result.current.setSheet({ mode: 'addrule' }); });
  act(() => { mockSetStatus('locked'); });
  expect(result.current.sheet).toEqual({ mode: 'addrule' });

  mockStatus = 'authed';
  act(() => { result.current.setSheet({ mode: 'applyRules' }); });
  act(() => { mockSetStatus('authed') });
  expect(result.current.sheet).toEqual({ mode: 'applyRules' });
});
