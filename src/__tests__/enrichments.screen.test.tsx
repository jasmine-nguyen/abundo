// Provider test: the rule WRITERS in AppProvider (WHIT-52 Slice 2). WHIT-192: the eager
// store is gone, so the writers (saveManualRule/deleteRule/updateRule) source + mutate the
// ['rules'] query cache via patchRules. These seed that cache and assert on it. The rule
// LOAD + error paths moved to the query layer (rulesScreenData.screen.test.tsx). renderHook
// drives useAppContext directly.
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

const rules = () => queryClient.getQueryData<Rule[]>(['rules']) ?? [];
// The ['rules'] cache holds already-mapped Rule objects (the query's select maps
// value→pattern). NETFLIX rule mapped from the server shape.
const NETFLIX: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };

// WHIT-192: seed the ['rules'] cache the writers patch (the provider no longer loads it).
// patchRules is a no-op on an absent cache, so every writer test seeds at least [].
function seed(seedRules: Rule[] = []) {
  queryClient.setQueryData(['rules'], seedRules);
  queryClient.setQueryData(['categories'], []);
}

beforeEach(() => {
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
});

it('saveManualRule creates the rule and swaps the temp id for the server id', async () => {
  mockApi.createEnrichment.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  // Sent as typed (trimmed, not upper-cased); no field/operator (server defaults).
  expect(mockApi.createEnrichment).toHaveBeenCalledWith({ value: 'spotify', categoryId: 'subs' });
  // Reconciled to the server id, but keeps isNew:true so the "NEW" badge survives.
  expect(rules()[0]).toEqual({ id: 'e9', pattern: 'spotify', categoryId: 'subs', isNew: true, field: 'description', operator: 'contains' });
});

it('saveManualRule rolls back the optimistic rule when the create fails', async () => {
  mockApi.createEnrichment.mockRejectedValue(new Error('API error: 400'));
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(rules()).toEqual([]);
  expect(result.current.toast).toBe('Could not save rule. Please try again.');
});

it('deleteRule removes the rule on success', async () => {
  mockApi.deleteEnrichment.mockResolvedValue({ id: 'e1' });
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(mockApi.deleteEnrichment).toHaveBeenCalledWith('e1');
  expect(rules()).toEqual([]);
});

it('updateRule edits in place and preserves the rule field/operator', async () => {
  // A non-default (category equals) rule must not be reset to description/contains.
  const catRule: Rule = { id: 'e1', pattern: 'FOOD_AND_DRINK', categoryId: 'eatingout', isNew: false, field: 'category', operator: 'equals' };
  mockApi.updateEnrichment.mockResolvedValue({ id: 'e1', field: 'category', operator: 'equals', value: 'GROCERIES', categoryId: 'groceries' });
  seed([catRule]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.updateRule('e1', 'GROCERIES', 'groceries'); });

  expect(mockApi.updateEnrichment).toHaveBeenCalledWith('e1', { value: 'GROCERIES', categoryId: 'groceries', field: 'category', operator: 'equals' });
  expect(rules()[0]).toEqual({ id: 'e1', pattern: 'GROCERIES', categoryId: 'groceries', isNew: false, field: 'category', operator: 'equals' });
});

it('updateRule rolls back to the original rule when the update fails', async () => {
  mockApi.updateEnrichment.mockRejectedValue(new Error('boom'));
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.updateRule('e1', 'SPOTIFY', 'subs'); });

  expect(rules()[0]).toEqual({ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' });
  expect(result.current.toast).toBe('Could not update rule. Please try again.');
});

it('deleteRule restores the rule at its position when the delete fails', async () => {
  mockApi.deleteEnrichment.mockRejectedValue(new Error('boom'));
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(rules()).toHaveLength(1);
  expect(rules()[0].id).toBe('e1');
  expect(result.current.toast).toBe('Could not delete rule. Please try again.');
});
