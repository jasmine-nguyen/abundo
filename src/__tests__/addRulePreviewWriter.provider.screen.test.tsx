// WHIT-538 — the two context actions behind the add-rule preview: previewNewRule and fileNewRule.
//
// Both act on a NOT-YET-CREATED rule via an inline apply-rules call, so the properties that carry
// real risk are:
//   - the inline rule reaches the wire (value = the TRIMMED typed pattern, categoryId = the pick);
//   - previewNewRule dry-runs and writes nothing;
//   - fileNewRule mints + files: it patches the filed rows AND prepends the minted rule to ['rules']
//     with its "NEW" badge, and SKIPS re-invalidating ['rules'] so the badge survives the refresh;
//   - when the server omits createdRule (older build), fileNewRule falls back to invalidating ['rules'];
//   - a 409 clash is DISTINCT from any other failure ({clash: ApiError} vs {clash: null}) and on a
//     clash NOTHING is written and NOTHING refreshed;
//   - it shares the in-flight latch with applyRulesToHistory;
//   - a run settling after sign-out paints nothing.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Transaction, Rule, ApplyRulesResult } from '../context';
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
  dryRun: false, rulesConsidered: 1, unfiled: 3, matched: 1, conflicted: 0, conflictedSamples: [],
  byCategory: { groceries: 1 }, byRule: [], skippedRules: [],
  filed: [{ id: 't1', category: 'groceries' }], vanished: [], failed: [], remaining: 0,
  createdRule: { id: 'r1', field: 'description', operator: 'contains', value: 'coles', categoryId: 'groceries' },
  ...over,
});

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

// --- previewNewRule: the dry run ----------------------------------------------

// The load-bearing wire property: dryRun true + inline {value: TRIMMED pattern, categoryId}. The
// trim matters — the form may pass padded text. Fail-on-revert: drop the .trim() and the padded
// value reaches the wire.
it('previews with dryRun true and the trimmed inline rule, writing nothing', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ dryRun: true, filed: [], createdRule: null }));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: Awaited<ReturnType<typeof result.current.previewNewRule>> | null = null;
  await act(async () => { outcome = await result.current.previewNewRule('  COLES  ', 'groceries'); });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(true, { value: 'COLES', categoryId: 'groceries', budgetExcluded: false });
  expect(outcome!.ok).toBe(true);
  expect(spy).not.toHaveBeenCalled();                     // a preview reconciles nothing
  expect(rowsIn('transactions')[0].category).toBeNull();  // ...and touches no row
  spy.mockRestore();
});

it('surfaces a 409 clash from the preview (distinct from a generic failure)', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));

  const result = mount();
  let outcome: Awaited<ReturnType<typeof result.current.previewNewRule>> | null = null;
  await act(async () => { outcome = await result.current.previewNewRule('COLES', 'groceries'); });

  expect(outcome).toEqual({ ok: false, clash: expect.any(ApiError) });
});

// --- fileNewRule: the mint + file ---------------------------------------------

it('sends the trimmed inline rule with dryRun false and patches the filed row', async () => {
  seedTransactionsCache(queryClient, [txn(), txn({ transaction_id: 'untouched' })]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ filed: [{ id: 't1', category: 'groceries' }] }));

  const result = mount();
  let outcome: Awaited<ReturnType<typeof result.current.fileNewRule>> | null = null;
  await act(async () => { outcome = await result.current.fileNewRule('  COLES  ', 'groceries'); });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledWith(false, { value: 'COLES', categoryId: 'groceries', budgetExcluded: false });
  expect(outcome).toEqual({ ok: true, report: expect.objectContaining({ filed: [{ id: 't1', category: 'groceries' }] }) });
  const byId = new Map(rowsIn('transactions').map((r) => [r.transaction_id, r.category]));
  expect(byId.get('t1')).toBe('groceries');
  expect(byId.get('untouched')).toBeNull();
});

// The minted rule must appear in the Rules list WITH its "NEW" badge — so fileNewRule prepends the
// createdRule to ['rules'] (isNew true) and SKIPS re-invalidating ['rules'] (a refetch would reset
// the badge). Fail-on-revert: drop the skipRules flag and ['rules'] is invalidated (badge would flash away).
it('prepends the minted rule to the rules cache with isNew and does NOT invalidate ["rules"]', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  queryClient.setQueryData<Rule[]>(['rules'], [{ id: 'existing', pattern: 'KMART', categoryId: 'fuel', isNew: false }]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report());

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.fileNewRule('COLES', 'groceries'); });

  const rules = queryClient.getQueryData<Rule[]>(['rules'])!;
  expect(rules[0]).toEqual({ id: 'r1', pattern: 'coles', categoryId: 'groceries', isNew: true, field: 'description', operator: 'contains' });
  expect(rules[1].id).toBe('existing');
  expect(invalidatedKeys(spy)).not.toContain('rules');           // badge preserved
  expect(invalidatedKeys(spy)).toEqual(expect.arrayContaining(['uncategorizedMerchants', 'uncategorizedCount']));
  spy.mockRestore();
});

// Older server: no createdRule in the response → we can't optimistically place it, so fall back to
// invalidating ['rules'] so the rule still lands on refetch. Fail-on-revert: drop the else branch and
// ['rules'] is never refreshed → a minted rule the client can't see.
it('falls back to invalidating ["rules"] when the server omits createdRule', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockResolvedValue(report({ createdRule: null }));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  await act(async () => { await result.current.fileNewRule('COLES', 'groceries'); });

  expect(invalidatedKeys(spy)).toContain('rules');
  spy.mockRestore();
});

// The clash: an existing rule already files this pattern elsewhere. DISTINCT from a generic failure,
// AND writes/refreshes nothing (the server minted nothing).
it('returns { clash } and refreshes nothing on a 409 clash', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new ApiError(409, null));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: Awaited<ReturnType<typeof result.current.fileNewRule>> | null = null;
  await act(async () => { outcome = await result.current.fileNewRule('COLES', 'groceries'); });

  expect(outcome).toEqual({ ok: false, clash: expect.any(ApiError) });
  expect(spy).not.toHaveBeenCalled();
  expect(rowsIn('transactions')[0].category).toBeNull();
  spy.mockRestore();
});

// Any OTHER failure is an UNKNOWN outcome, so it still refreshes — but clash stays null.
it('returns { clash: null } and still refreshes on a non-clash failure', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  mockApi.applyRulesToUncategorized.mockRejectedValue(new Error('API error: 502'));

  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');
  let outcome: Awaited<ReturnType<typeof result.current.fileNewRule>> | null = null;
  await act(async () => { outcome = await result.current.fileNewRule('COLES', 'groceries'); });

  expect(outcome).toEqual({ ok: false, clash: null });
  expect(invalidatedKeys(spy)).toContain('uncategorizedCount');
  spy.mockRestore();
});

// The shared latch: "Apply my rules", "File by shop" and "file new rule" must never run at once.
// Fail-on-revert: give fileNewRule its own latch and the blocked call fires a second api request.
it('shares the in-flight latch with applyRulesToHistory', async () => {
  seedTransactionsCache(queryClient, [txn()]);
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);

  const result = mount();
  await act(async () => {
    const first = result.current.fileNewRule('COLES', 'groceries'); // holds the latch
    const blocked = await result.current.applyRulesToHistory();      // must be turned away
    expect(blocked).toBeNull();
    pending.resolve(report());
    await first;
  });

  expect(mockApi.applyRulesToUncategorized).toHaveBeenCalledTimes(1);
});

// A file settling after sign-out must not paint the next session's caches.
it('bails without painting when a file settles after sign-out', async () => {
  const pending = deferred<ApplyRulesResult>();
  mockApi.applyRulesToUncategorized.mockReturnValue(pending.promise);
  const result = mount();

  let outcome: Awaited<ReturnType<typeof result.current.fileNewRule>> | null = null;
  await act(async () => {
    const inFlight = result.current.fileNewRule('COLES', 'groceries');
    mockSetStatus('anon');
    seedTransactionsCache(queryClient, [txn()]);
    pending.resolve(report({ filed: [{ id: 't1', category: 'groceries' }] }));
    outcome = await inFlight;
  });

  expect(outcome).toEqual({ ok: false, clash: null });
  expect(rowsIn('transactions')[0].category).toBeNull();
});
