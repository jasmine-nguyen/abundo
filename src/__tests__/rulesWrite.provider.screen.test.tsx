// WHIT-195/192 — the rule writes target the ['rules'] query cache the Rules screen reads.
// (Pre-192 they double-wrote an old store too; that store is now gone, so these assert on
// the cache alone.) The client-only isNew "NEW" badge must survive the cache write (a refetch
// would reset it), and deleteCategory's cascade drops the category's rules from the cache
// WITHOUT invalidating (so a refetch can't resurrect them). Drives the REAL writers via
// AppProvider + the singleton queryClient. The cache is seeded first (as if the Rules screen
// had loaded) so patchRules's `prev` is defined — an un-opened Rules screen has nothing to patch.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Rule } from '../context';
import { queryClient } from '../queryClient';

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
