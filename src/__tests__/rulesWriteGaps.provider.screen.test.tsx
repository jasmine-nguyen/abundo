// WHIT-195 GAPS — adversarial half of the rule-write double-write, complementing
// rulesWrite.provider.screen.test.tsx (which locks saveManualRule/deleteRule/updateRule
// success + a failed create + deleteCategory). Here:
//   - applyCategory('all') mints a rule → the cache is mirrored too (NOT covered elsewhere).
//   - the absent-cache guard: a create while the Rules screen was never opened must NOT
//     crash and must NOT fabricate a partial ['rules'] cache (patchRules' `prev ?` branch).
//   - updateRule / deleteRule FAILURE paths roll the CACHE back (only success/failed-create
//     cache paths are locked upstream).
//   - a MOUNTED useRulesQuery observer sees a write instantly, with NO refetch (read-your-write).
// Drives the REAL writers via AppProvider + the singleton queryClient (the one context.tsx
// patches). Fails on revert: swap patchRules back to setRules and every cache assertion breaks.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProvider, useAppContext } from '../context';
import type { Rule } from '../context';
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
const cacheRules = () => queryClient.getQueryData<Rule[]>(['rules']);

beforeEach(() => {
  queryClient.clear();
  mockApi.fetchTransactions.mockResolvedValue([]);
  mockApi.fetchCategories.mockResolvedValue([{ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a' } as never]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchBreakdown.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchLoanFacts.mockResolvedValue({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.listEnrichments.mockResolvedValue([{ ...SERVER_RULE }]);
});
afterEach(() => { queryClient.clear(); });

// Mount, wait for the store's rules to load, then seed the cache to match (as if a mounted
// useRulesQuery observer had already loaded it) so patchRules' `prev` is defined.
async function mountWithSeededCache() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  act(() => { queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]); });
  return result;
}

// Seed the cache to a value that DIVERGES from the store (a rule whose pattern differs). A
// failure path rolls back to a value that equals the original seed, so an equal seed can't
// tell a mirrored rollback from a cache the writer never touched. Diverging the seed makes
// the catch-branch's cache write observable: only a real mirror reconciles it to the store.
async function mountWithDivergentCache() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  act(() => { queryClient.setQueryData<Rule[]>(['rules'], [{ ...RULE_E1, pattern: 'DIVERGED' }]); });
  return result;
}

it("applyCategory('all') mirrors the minted rule into the cache with isNew:true", async () => {
  // A single uncategorised charge is in the store; the confirm sheet targets it. Make it NOT
  // count to budget so no batch call fires — the test is only about the minted RULE mirror.
  mockApi.fetchTransactions.mockResolvedValue([
    { transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01', description: 'NETFLIX', merchant_name: 'Netflix', amount: -15, account_id: 'a1', account_name: 'Everyday', category: null, status: 'posted', type: 'purchase', counts_to_budget: false } as never,
  ]);
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' });
  const result = await mountWithSeededCache();

  act(() => { result.current.setSheet({ mode: 'confirm', txId: 't1', categoryId: 'subs' } as never); });
  await act(async () => { await result.current.applyCategory('all'); });

  // The rule the "apply to all" flow mints lands in BOTH the store and the cache, prepended,
  // carrying the NEW badge (isNew:true) through the server reconcile.
  expect(result.current.rules[0]).toMatchObject({ id: 'e9', categoryId: 'subs', isNew: true });
  expect(cacheRules()?.[0]).toMatchObject({ id: 'e9', categoryId: 'subs', isNew: true });
  expect(cacheRules()).toHaveLength(2);
});

it('a create while the Rules screen was never opened is a no-op on the (absent) cache — no crash, no phantom cache', async () => {
  // No cache seed: the ['rules'] query was never mounted, so getQueryData is undefined.
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  // The store still updated…
  expect(result.current.rules[0]).toMatchObject({ id: 'e9', isNew: true });
  // …but patchRules' `prev ? fn(prev) : prev` guard left the cache untouched (undefined) —
  // no crash from spreading undefined, and no half-built ['rules'] cache to mislead a later reader.
  expect(cacheRules()).toBeUndefined();
});

it('updateRule FAILURE mirrors the rollback into the cache (reconciles a diverged cache to the store)', async () => {
  mockApi.updateEnrichment.mockRejectedValue(new Error('boom'));
  const result = await mountWithDivergentCache();

  await act(async () => { await result.current.updateRule('e1', 'SPOTIFY', 'subs'); });

  // The store rolls back to NETFLIX; the catch-branch patchRules writes that SAME rollback into
  // the cache, overwriting the diverged 'DIVERGED' seed. Equal store+cache proves the mirror ran.
  expect(result.current.rules[0].pattern).toBe('NETFLIX');
  expect(cacheRules()?.[0].pattern).toBe('NETFLIX');
  expect(cacheRules()).toEqual([RULE_E1]);
});

it('deleteRule FAILURE re-inserts the rule into the cache (catch-branch mirror, not a no-op)', async () => {
  mockApi.deleteEnrichment.mockRejectedValue(new Error('boom'));
  const result = await mountWithDivergentCache();

  await act(async () => { await result.current.deleteRule('e1'); });

  // Optimistic filter empties the cache, then the catch re-inserts the removed rule (the store's
  // NETFLIX row) — overwriting the diverged seed. A non-mirroring writer would leave 'DIVERGED'.
  expect(result.current.rules).toEqual([RULE_E1]);
  expect(cacheRules()).toEqual([RULE_E1]);
});

it('a MOUNTED useRulesQuery observer reflects saveManualRule instantly, with no refetch', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  const { result } = renderHook(() => ({ ctx: useAppContext(), screen: useRulesScreenData() }), { wrapper: observerWrapper });

  // The active ['rules'] observer loads the one server rule.
  await waitFor(() => expect(result.current.screen.rules).toHaveLength(1));
  const fetchesBefore = mockApi.listEnrichments.mock.calls.length;

  await act(async () => { await result.current.ctx.saveManualRule('spotify', 'subs'); });

  // The observer (the Rules screen while mounted) sees the new rule without a refetch —
  // the optimistic mirror is enough; no ['rules'] invalidate is issued.
  expect(result.current.screen.rules[0]).toMatchObject({ id: 'e9', categoryId: 'subs', isNew: true });
  expect(result.current.screen.rules).toHaveLength(2);
  expect(mockApi.listEnrichments.mock.calls.length).toBe(fetchesBefore);
});
