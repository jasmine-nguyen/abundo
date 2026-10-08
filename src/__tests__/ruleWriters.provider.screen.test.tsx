// Provider test: the rule WRITERS in AppProvider (WHIT-52 Slice 2). WHIT-192: the eager
// store is gone, so the writers (saveManualRule/deleteRule/updateRule) source + mutate the
// ['rules'] query cache via patchRules. These seed that cache and assert on it. The rule
// LOAD + error paths moved to the query layer (rulesScreenData.screen.test.tsx). renderHook
// drives useAppContext directly.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

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
  server.once('POST', '/rules', { body: { id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' } });
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  // Sent as typed (trimmed, not upper-cased); no field/operator (server defaults).
  expect(server.requests()).toContainEqual({ method: 'POST', path: '/rules', body: { value: 'spotify', categoryId: 'subs', budgetExcluded: false, spread: false } });
  // Reconciled to the server id, but keeps isNew:true so the "NEW" badge survives.
  expect(rules()[0]).toEqual({ id: 'e9', pattern: 'spotify', categoryId: 'subs', isNew: true, field: 'description', operator: 'contains' });
});

it('saveManualRule rolls back the optimistic rule when the create fails', async () => {
  server.once('POST', '/rules', { status: 400 });
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(rules()).toEqual([]);
  expect(result.current.toast).toBe('Could not save rule. Please try again.');
});

it('deleteRule removes the rule on success', async () => {
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(server.requests()).toContainEqual({ method: 'DELETE', path: '/rules/e1', body: undefined });
  expect(rules()).toEqual([]);
});

it('updateRule edits in place and preserves the rule field/operator', async () => {
  // A non-default (category equals) rule must not be reset to description/contains.
  const catRule: Rule = { id: 'e1', pattern: 'FOOD_AND_DRINK', categoryId: 'eatingout', isNew: false, field: 'category', operator: 'equals' };
  server.once('PUT', '/rules/e1', { body: { id: 'e1', field: 'category', operator: 'equals', value: 'GROCERIES', categoryId: 'groceries' } });
  seed([catRule]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.updateRule('e1', 'GROCERIES', 'groceries'); });

  expect(server.requests()).toContainEqual({ method: 'PUT', path: '/rules/e1', body: { value: 'GROCERIES', categoryId: 'groceries', field: 'category', operator: 'equals', budgetExcluded: false, spread: false } });
  expect(rules()[0]).toEqual({ id: 'e1', pattern: 'GROCERIES', categoryId: 'groceries', isNew: false, field: 'category', operator: 'equals' });
});

it('updateRule rolls back to the original rule when the update fails', async () => {
  server.fail('/rules/e1', 500);
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.updateRule('e1', 'SPOTIFY', 'subs'); });

  expect(rules()[0]).toEqual({ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' });
  expect(result.current.toast).toBe('Could not update rule. Please try again.');
});

it('deleteRule restores the rule at its position when the delete fails', async () => {
  server.fail('/rules/e1', 500);
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(rules()).toHaveLength(1);
  expect(rules()[0].id).toBe('e1');
  expect(result.current.toast).toBe('Could not delete rule. Please try again.');
});
