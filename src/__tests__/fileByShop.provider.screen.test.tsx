// WHIT-517 — the two context actions behind "File by shop": previewFileByShop and fileByShop.
//
// Both mint-and-file ONE shop in a single apply-rules call (an inline rule), so the properties that
// carry real risk are:
//   - the inline rule reaches the wire (value = the group's rulePattern, categoryId = the pick), or
//     nothing is minted and nothing filed;
//   - a 409 clash (an existing rule already files this shop elsewhere) is kept DISTINCT from any
//     other failure — {clash: ApiError} vs {clash: null} — and on a clash NOTHING is written and
//     NOTHING is refreshed (the server minted nothing);
//   - any OTHER failure still refreshes the caches (the write may have partly landed), like
//     applyRulesToHistory;
//   - a success patches the filed rows and refreshes the "file by shop" list (['uncategorizedMerchants'])
//     and the rules list (['rules']) so the filed shop leaves the list and the new rule appears;
//   - it shares the in-flight latch with applyRulesToHistory, so the two bulk actions can't overlap;
//   - a run settling after sign-out paints nothing.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, ApplyRulesResult } from '../context';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

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
  createdRule: { id: 'r1', field: 'description', operator: 'contains', value: 'coles', categoryId: 'groceries' },
  ...over,
});

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 1,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};

function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}
function rowsIn(key: 'transactions'): Transaction[] {
  const data = queryClient.getQueryData<{ pages: { transactions: Transaction[] }[] }>([key]);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}
function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => { queryClient.clear(); jest.clearAllMocks(); mockStatus = 'authed'; });
afterEach(() => { queryClient.clear(); });

// --- fileByShop: the write ----------------------------------------------------

// The load-bearing wire property: the inline rule must be {value: rulePattern, categoryId}. Fail-on-
// revert: drop the rule arg and the call goes out as a plain sweep, minting nothing.
it('sends the inline rule (value = the group pattern, category = the pick) with dryRun false', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());

  const result = mount();
  await act(async () => { await result.current.fileByShop(GROUP, 'groceries'); });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(false, { value: 'coles', categoryId: 'groceries' });
});

it('patches the filed row and returns { ok, report } on success', async () => {
  seedTransactionsCache(queryClient, [txn(), txn({ transaction_id: 'untouched' })]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ filed: [{ id: 't1', category: 'groceries' }] }));

  const result = mount();
  let outcome: Awaited<ReturnType<typeof result.current.fileByShop>> | null = null;
  await act(async () => { outcome = await result.current.fileByShop(GROUP, 'groceries'); });

  expect(outcome).toEqual({ ok: true, report: expect.objectContaining({ filed: [{ id: 't1', category: 'groceries' }] }) });
  const byId = new Map(rowsIn('transactions').map((r) => [r.transaction_id, r.category]));
  expect(byId.get('t1')).toBe('groceries');
  expect(byId.get('untouched')).toBeNull();
});

// The WHIT-517 invalidations: the filed shop must leave the "file by shop" list, and the new rule
// must appear in the rules list. Fail-on-revert: drop either invalidateQueries and its key is gone.
it('invalidates the shop list and the rules list after a successful file', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.fileByShop(GROUP, 'groceries'); });

  expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['uncategorizedMerchants', 'rules', 'uncategorizedCount']));
  spy.mockRestore();
});

// The clash: an existing rule already files this shop elsewhere. It must be DISTINCT from a generic
// failure (so the sheet shows its clash copy) AND write/refresh nothing (the server minted nothing).
// Fail-on-revert: collapse the 409 to a bare null and `clash` goes null; refresh on a clash and the
// invalidate spy fires.
it('returns { clash } and refreshes nothing on a 409 clash', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: Awaited<ReturnType<typeof result.current.fileByShop>> | null = null;
  await act(async () => { outcome = await result.current.fileByShop(GROUP, 'groceries'); });

  expect(outcome).toEqual({ ok: false, clash: expect.any(ApiError) });
  expect(spy).not.toHaveBeenCalled();               // nothing was minted → nothing to refresh
  expect(rowsIn('transactions')[0].category).toBeNull();
  spy.mockRestore();
});

// Any OTHER failure is an UNKNOWN outcome (row-by-row writes, a late abort), so it still refreshes —
// but clash stays null so the sheet does NOT show the clash copy. Fail-on-revert: drop the refresh
// from the catch and the invalidate spy never fires.
it('returns { clash: null } and still refreshes on a non-clash failure', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new Error('API error: 502'));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: Awaited<ReturnType<typeof result.current.fileByShop>> | null = null;
  await act(async () => { outcome = await result.current.fileByShop(GROUP, 'groceries'); });

  expect(outcome).toEqual({ ok: false, clash: null });
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// The shared latch: "Apply my rules" and "File by shop" must never run at once (two whole-history
// mint+file passes racing would resolve out of order). Fail-on-revert: give fileByShop its own latch
// and the second call fires a second api request.
it('shares the in-flight latch with applyRulesToHistory', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);

  const result = mount();
  await act(async () => {
    const first = result.current.fileByShop(GROUP, 'groceries');   // holds the latch
    const blocked = await result.current.applyRulesToHistory();     // must be turned away
    expect(blocked).toBeNull();
    pending.resolve(report());
    await first;
  });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledTimes(1);
});

// --- previewFileByShop: the dry run -------------------------------------------

it('previews with dryRun true and the inline rule, writing nothing', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ dryRun: true, filed: [], createdRule: null }));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: Awaited<ReturnType<typeof result.current.previewFileByShop>> | null = null;
  await act(async () => { outcome = await result.current.previewFileByShop(GROUP, 'groceries'); });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(true, { value: 'coles', categoryId: 'groceries' });
  expect(outcome!.ok).toBe(true);
  expect(spy).not.toHaveBeenCalled();                        // a preview reconciles nothing
  expect(rowsIn('transactions')[0].category).toBeNull();     // ...and touches no row
  spy.mockRestore();
});

it('surfaces a 409 clash from the preview (distinct from a generic failure)', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));

  const result = mount();
  let outcome: Awaited<ReturnType<typeof result.current.previewFileByShop>> | null = null;
  await act(async () => { outcome = await result.current.previewFileByShop(GROUP, 'groceries'); });

  expect(outcome).toEqual({ ok: false, clash: expect.any(ApiError) });
});

it('returns { clash: null } when the preview fails for any other reason', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new Error('API error: 502'));

  const result = mount();
  let outcome: Awaited<ReturnType<typeof result.current.previewFileByShop>> | null = null;
  await act(async () => { outcome = await result.current.previewFileByShop(GROUP, 'groceries'); });

  expect(outcome).toEqual({ ok: false, clash: null });
});

// --- session safety -----------------------------------------------------------

// A file settling after sign-out must not paint the next session's caches. Fail-on-revert: drop the
// post-await epoch check and the signed-out session gets the old account's row filed.
it('bails without painting when a file settles after sign-out', async () => {
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();

  let outcome: Awaited<ReturnType<typeof result.current.fileByShop>> | null = null;
  await act(async () => {
    const inFlight = result.current.fileByShop(GROUP, 'groceries');
    mockSetStatus('anon');
    seedTransactionsCache(queryClient, [txn()]);
    pending.resolve(report({ filed: [{ id: 't1', category: 'groceries' }] }));
    outcome = await inFlight;
  });

  expect(outcome).toEqual({ ok: false, clash: null });
  expect(rowsIn('transactions')[0].category).toBeNull();
});
