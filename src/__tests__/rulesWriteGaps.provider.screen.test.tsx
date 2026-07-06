// WHIT-195/192 GAPS — adversarial half of the rule-write cache path, complementing
// rulesWrite.provider.screen.test.tsx. Here:
//   - applyCategory('all') mints a rule → the ['rules'] cache is written too.
//   - the absent-cache guard: a create while the Rules screen was never opened must NOT
//     crash and must NOT fabricate a partial ['rules'] cache (patchRules' `prev ?` branch).
//   - updateRule / deleteRule FAILURE paths write the optimistic change into the cache
//     mid-flight, then roll it back (a mid-flight assertion keeps the teeth cache-only).
//   - a MOUNTED useRulesQuery observer sees a write instantly, with NO refetch (read-your-write).
// Drives the REAL writers via AppProvider + the singleton queryClient (the one context.tsx
// patches). Fails on revert: drop the patchRules cache write and every cache assertion breaks.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProvider, useAppContext } from '../context';
import type { Rule, Transaction } from '../context';
import { useRulesScreenData } from '../queries';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;
// The mounted-observer wrapper: the singleton queryClient wraps AppProvider, so an active
// useRulesQuery observer and the context's patchRules share the exact same cache.
const observerWrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <AppProvider>{children}</AppProvider>
  </QueryClientProvider>
);

const SERVER_RULE = { id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' } as const;
const RULE_E1: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };
const SUBS_CAT = { id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 };
const cacheRules = () => queryClient.getQueryData<Rule[]>(['rules']);

beforeEach(() => {
  queryClient.clear();
  // Only the mounted-observer test fetches (via the real useRulesQuery); the rest read
  // the seeded cache directly. The provider no longer eager-loads.
  mockApi.listEnrichments.mockResolvedValue([{ ...SERVER_RULE }]);
});
afterEach(() => { queryClient.clear(); });

// WHIT-192: seed the caches the writers read (the provider no longer eager-loads).
function seedCache(over: { rules?: Rule[]; transactions?: Transaction[] } = {}) {
  queryClient.setQueryData<Rule[]>(['rules'], over.rules ?? [RULE_E1]);
  queryClient.setQueryData(['categories'], [SUBS_CAT]);
  queryClient.setQueryData(['transactions'], over.transactions ?? []);
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
  seedCache({ transactions: [tx] });
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
