// WHIT-195 — the rule writes DOUBLE-WRITE the ['rules'] query cache (the migrated Rules
// screen reads it) alongside the old store, applying the same functional updater to both.
// Crucially the client-only isNew "NEW" badge survives the cache mirror (a refetch would
// reset it), and deleteCategory's cascade drops the category's rules from the cache WITHOUT
// invalidating (so a refetch can't resurrect them). Drives the REAL writers via AppProvider
// + the singleton queryClient. The cache is seeded first (as if the Rules screen had loaded)
// so the mirror's `prev` is defined — an un-opened Rules screen has nothing to patch.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Rule } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

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
afterEach(() => {
  queryClient.clear();
});

// Mount, wait for the store's rules to load, then seed the cache to match (simulating a
// mounted useRulesQuery observer). Returns the hook result.
async function mountWithSeededCache() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  act(() => { queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]); });
  return result;
}

it('saveManualRule double-writes the cache and keeps isNew:true through the reconcile', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  const result = await mountWithSeededCache();

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  // Store AND cache both hold the reconciled server rule, prepended, with the NEW badge.
  const expected: Rule = { id: 'e9', pattern: 'spotify', categoryId: 'subs', isNew: true, field: 'description', operator: 'contains' };
  expect(result.current.rules[0]).toEqual(expected);
  expect(cacheRules()?.[0]).toEqual(expected);   // <-- cache double-write, isNew preserved
  expect(cacheRules()).toHaveLength(2);
});

it('deleteRule removes the rule from the cache too', async () => {
  mockApi.deleteEnrichment.mockResolvedValue({ id: 'e1' });
  const result = await mountWithSeededCache();

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(result.current.rules).toEqual([]);
  expect(cacheRules()).toEqual([]);   // dropped from the cache as well
});

it('updateRule edits the cached rule in place', async () => {
  mockApi.updateEnrichment.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'DISNEY', categoryId: 'subs' });
  const result = await mountWithSeededCache();

  await act(async () => { await result.current.updateRule('e1', 'DISNEY', 'subs'); });

  expect(cacheRules()?.[0].pattern).toBe('DISNEY');
  expect(result.current.rules[0].pattern).toBe('DISNEY');
});

it('a failed save mirrors the optimistic add into the cache, then rolls it back', async () => {
  mockApi.createEnrichment.mockRejectedValue(new Error('API error: 400'));
  const result = await mountWithSeededCache();

  // Observe the optimistic add reaching the cache MID-FLIGHT (before the reject), so this
  // test has teeth: without the patchRules mirror the optimistic rule never hits the cache
  // and midCount stays 1 — a pure end-state assertion would net to [RULE_E1] either way.
  let midCount: number | undefined;
  await act(async () => {
    const p = result.current.saveManualRule('spotify', 'subs');
    midCount = cacheRules()?.length; // optimistic add mirrored → 2
    await p;
  });

  expect(midCount).toBe(2);                  // <-- fails if the cache mirror is removed
  expect(result.current.rules).toEqual([RULE_E1]);
  expect(cacheRules()).toEqual([RULE_E1]);   // cache rolled back to the pre-save list
});

it('deleteCategory drops the category rules from the cache without resurrecting them', async () => {
  mockApi.deleteCategory.mockResolvedValue(undefined as never);
  const result = await mountWithSeededCache();

  await act(async () => { await result.current.deleteCategory('subs'); });

  // The rule targeting the deleted category is gone from BOTH — and because deleteCategory
  // mirrors (setQueryData) rather than invalidates, no refetch can resurrect it.
  expect(result.current.rules).toEqual([]);
  expect(cacheRules()).toEqual([]);
});
