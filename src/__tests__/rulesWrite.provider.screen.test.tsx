// WHIT-195/192 — the rule writes target the ['rules'] query cache the Rules screen reads.
// (Pre-192 they double-wrote an old store too; that store is now gone, so these assert on
// the cache alone.) The client-only isNew "NEW" badge must survive the cache write (a refetch
// would reset it), and deleteCategory's cascade drops the category's rules from the cache
// WITHOUT invalidating (so a refetch can't resurrect them). Drives the REAL writers via
// AppProvider + the singleton queryClient. The cache is seeded first (as if the Rules screen
// had loaded) so patchRules's `prev` is defined — an un-opened Rules screen has nothing to patch.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProvider, useAppContext } from '../context';
import type { Rule, Transaction } from '../context';
import { useRulesScreenData } from '../queries';
import { queryClient } from '../queryClient';
import { seedTransactionsCache } from './support/transactionsCache';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const RULE_E1: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };

const cacheRules = () => queryClient.getQueryData<Rule[]>(['rules']);

beforeEach(() => {
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
});

// WHIT-192: seed the ['rules'] cache the writers patch + the ['categories'] cache
// deleteCategory reads, then mount (the provider no longer eager-loads).
function mountWithSeededCache() {
  queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]);
  queryClient.setQueryData(['categories'], [{ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saveManualRule writes the cache and keeps isNew:true through the reconcile', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  const result = mountWithSeededCache();

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  // The cache holds the reconciled server rule, prepended, with the NEW badge preserved.
  const expected: Rule = { id: 'e9', pattern: 'spotify', categoryId: 'subs', isNew: true, field: 'description', operator: 'contains' };
  expect(cacheRules()?.[0]).toEqual(expected);   // <-- cache write, isNew preserved
  expect(cacheRules()).toHaveLength(2);
});

it('deleteRule removes the rule from the cache', async () => {
  mockApi.deleteEnrichment.mockResolvedValue({ id: 'e1' });
  const result = mountWithSeededCache();

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(cacheRules()).toEqual([]);
});

it('updateRule edits the cached rule in place', async () => {
  mockApi.updateEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'DISNEY', categoryId: 'subs' });
  const result = mountWithSeededCache();

  await act(async () => { await result.current.updateRule('e1', 'DISNEY', 'subs'); });

  expect(cacheRules()?.[0].pattern).toBe('DISNEY');
});

it('a failed save mirrors the optimistic add into the cache, then rolls it back', async () => {
  mockApi.createEnrichment.mockRejectedValue(new Error('API error: 400'));
  const result = mountWithSeededCache();

  // Observe the optimistic add reaching the cache MID-FLIGHT (before the reject), so this
  // test has teeth: without the patchRules write the optimistic rule never hits the cache
  // and midCount stays 1 — a pure end-state assertion would net to [RULE_E1] either way.
  let midCount: number | undefined;
  await act(async () => {
    const p = result.current.saveManualRule('spotify', 'subs');
    midCount = cacheRules()?.length; // optimistic add mirrored → 2
    await p;
  });

  expect(midCount).toBe(2);                  // <-- fails if the cache write is removed
  expect(cacheRules()).toEqual([RULE_E1]);   // cache rolled back to the pre-save list
});

it('deleteCategory drops the category rules from the cache without resurrecting them', async () => {
  mockApi.deleteCategory.mockResolvedValue(undefined as never);
  const result = mountWithSeededCache();

  await act(async () => { await result.current.deleteCategory('subs'); });

  // The rule targeting the deleted category is gone — and because deleteCategory mirrors
  // (setQueryData) rather than invalidates, no refetch can resurrect it.
  expect(cacheRules()).toEqual([]);
});

// ===== WHIT-195/192 (folded from rulesWriteGaps.provider.screen.test.tsx)
// ADVERSARIAL half of the rule-write cache path: applyCategory('all') mints a rule into the
// ['rules'] cache; the absent-cache guard (create while the Rules screen was never opened must not
// crash / fabricate a partial cache); updateRule / deleteRule FAILURE paths write optimistically
// then roll back; and a MOUNTED useRulesQuery observer sees the write instantly with NO refetch.
// Reuses this file's RULE_E1 / cacheRules (byte-identical). Block-scopes the gaps-only helpers
// (observerWrapper, seedCache, mount) and consts (SERVER_RULE, SUBS_CAT).
describe('WHIT-195/192 rule-write gaps (folded)', () => {
  const SERVER_RULE = { id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' } as const;
  const SUBS_CAT = { id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 };
  // The mounted-observer wrapper: the singleton queryClient wraps AppProvider, so an active
  // useRulesQuery observer and the context's patchRules share the exact same cache.
  const observerWrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AppProvider>{children}</AppProvider>
    </QueryClientProvider>
  );

  beforeEach(() => {
    // Only the mounted-observer test fetches (via the real useRulesQuery); the rest read
    // the seeded cache directly. The provider no longer eager-loads.
    mockApi.listEnrichments.mockResolvedValue([{ ...SERVER_RULE }]);
  });

  // WHIT-192: seed the caches the writers read (the provider no longer eager-loads).
  function seedCache(over: { rules?: Rule[]; transactions?: Transaction[] } = {}) {
    queryClient.setQueryData<Rule[]>(['rules'], over.rules ?? [RULE_E1]);
    queryClient.setQueryData(['categories'], [SUBS_CAT]);
    seedTransactionsCache(queryClient, over.transactions ?? []);
  }
  function mount() {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    return result;
  }

  it("applyCategory('all') writes the minted rule into the cache with isNew:true", async () => {
    // A single uncategorised charge in the cache; the confirm sheet targets it. Make it NOT
    // count to budget so no batch call fires — the test is only about the minted RULE write.
    const tx = { transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01', description: 'NETFLIX', merchant_name: 'Netflix', amount: -15, account_id: 'a1', account_name: 'Everyday', category: null, status: 'posted', type: 'purchase', counts_to_budget: false } as unknown as Transaction;
    mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' });
    // WHIT-355: seed a NON-matching existing rule. A same-pattern rule would now (correctly)
    // suppress the mint as a duplicate; here the flow still mints, which is what this test locks.
    seedCache({ transactions: [tx], rules: [{ id: 'other', pattern: 'SPOTIFY', categoryId: 'subs', isNew: false }] });
    const result = mount();

    act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'subs' }); });
    await act(async () => { await result.current.applyCategory('all'); });

    // The rule the "apply to all" flow mints lands in the cache, prepended, carrying the NEW
    // badge (isNew:true) through the server reconcile.
    expect(cacheRules()?.[0]).toMatchObject({ id: 'e9', categoryId: 'subs', isNew: true });
    expect(cacheRules()).toHaveLength(2);
  });

  it('a create while the Rules screen was never opened is a no-op on the (absent) cache — no crash, no phantom cache', async () => {
    // No ['rules'] seed: the query was never mounted, so getQueryData is undefined. Seed only
    // categories (the toast lookup) to prove the absent-cache guard, not a missing-category one.
    queryClient.setQueryData(['categories'], [SUBS_CAT]);
    mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
    const result = mount();

    await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

    // The server write still happened…
    expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'spotify', categoryId: 'subs' });
    // …but patchRules' `prev ? fn(prev) : prev` guard left the cache untouched (undefined) —
    // no crash from spreading undefined, and no half-built ['rules'] cache to mislead a later reader.
    expect(cacheRules()).toBeUndefined();
  });

  it('updateRule FAILURE writes the optimistic edit into the cache, then rolls it back', async () => {
    mockApi.updateEnrichment.mockRejectedValue(new Error('boom'));
    seedCache();
    const result = mount();

    // Observe the optimistic edit reaching the cache MID-FLIGHT (before the reject) so the test
    // has teeth: without the patchRules write the cache never changes and mid stays NETFLIX.
    let mid: string | undefined;
    await act(async () => {
      const p = result.current.updateRule('e1', 'SPOTIFY', 'subs');
      mid = cacheRules()?.[0].pattern;   // optimistic → SPOTIFY
      await p;
    });

    expect(mid).toBe('SPOTIFY');                // <-- fails if the cache write is removed
    expect(cacheRules()).toEqual([RULE_E1]);    // rolled back to the pre-edit rule
  });

  it('deleteRule FAILURE removes then re-inserts the rule in the cache (catch-branch, not a no-op)', async () => {
    mockApi.deleteEnrichment.mockRejectedValue(new Error('boom'));
    seedCache();
    const result = mount();

    let mid: number | undefined;
    await act(async () => {
      const p = result.current.deleteRule('e1');
      mid = cacheRules()?.length;   // optimistic remove → 0
      await p;
    });

    expect(mid).toBe(0);                        // <-- fails if the cache write is removed
    expect(cacheRules()).toEqual([RULE_E1]);    // re-inserted at its position on failure
  });

  it('a MOUNTED useRulesQuery observer reflects saveManualRule instantly, with no refetch', async () => {
    mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
    // Seed the ['rules'] cache FRESH (setQueryData stamps dataUpdatedAt=now), so the mounted
    // observer reads it synchronously without an initial fetch — deterministic, and it makes the
    // "no refetch after the write" assertion exact (listEnrichments must stay at zero calls).
    queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]);
    const { result } = renderHook(() => ({ ctx: useAppContext(), screen: useRulesScreenData() }), { wrapper: observerWrapper });
    await waitFor(() => expect(result.current.screen.rules).toHaveLength(1));
    expect(mockApi.listEnrichments).not.toHaveBeenCalled(); // fresh cache → no initial fetch

    await act(async () => { await result.current.ctx.saveManualRule('spotify', 'subs'); });

    // The observer (the Rules screen while mounted) sees the new rule without a refetch — the
    // optimistic write is enough; no ['rules'] invalidate is issued. waitFor lets the query
    // observer flush its cache-update notification (RQ batches these; the flush timing varies
    // once other suites have exercised the singleton notifyManager).
    await waitFor(() => expect(result.current.screen.rules).toHaveLength(2));
    expect(result.current.screen.rules[0]).toMatchObject({ id: 'e9', categoryId: 'subs', isNew: true });
    expect(mockApi.listEnrichments).not.toHaveBeenCalled();
  });
});
