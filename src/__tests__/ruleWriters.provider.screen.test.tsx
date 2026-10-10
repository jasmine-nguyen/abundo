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
import { invalidatedKeys } from './support/queryClient';
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

// WHIT-558: the "keep out of budget" flag threads through both writers into the API call and
// the ['rules'] cache row.
it.each([
  {
    name: 'saveManualRule passes budgetExcluded to createRule and into the cache',
    write: (ctx: ReturnType<typeof useAppContext>) => ctx.saveManualRule('splitwise', 'subs', true),
    sent: { method: 'POST', path: '/rules', body: { value: 'splitwise', categoryId: 'subs', budgetExcluded: true, spread: false } },
  },
  {
    name: 'updateRule passes budgetExcluded to the rules API and into the cache',
    write: (ctx: ReturnType<typeof useAppContext>) => ctx.updateRule('e1', 'NETFLIX', 'subs', true),
    sent: { method: 'PUT', path: '/rules/e1', body: { value: 'NETFLIX', categoryId: 'subs', field: 'description', operator: 'contains', budgetExcluded: true, spread: false } },
  },
])('$name', async ({ write, sent }) => {
  server.once('POST', '/rules', { body: { id: 'e9', field: 'description', operator: 'contains', value: 'splitwise', categoryId: 'subs', budgetExcluded: true } });
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await write(result.current); });

  expect(server.requests()).toContainEqual(sent);
  expect(rules()[0].budgetExcluded).toBe(true);
});

// WHIT-559: the spread flag threads through createRule and the server's captured amount/gap land in
// the ['rules'] cache row (via toRule), so the edit sheet can prefill them.
it('saveManualRule passes spread to createRule and the captured bill lands in the cache', async () => {
  server.once('POST', '/rules', { body: { id: 'e9', field: 'description', operator: 'contains', value: 'origin', categoryId: 'subs', spread: true, spreadAmount: 4250, spreadGapDays: 30 } });
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('origin', 'subs', false, undefined, true); });

  expect(server.requests()).toContainEqual({ method: 'POST', path: '/rules', body: { value: 'origin', categoryId: 'subs', budgetExcluded: false, spread: true } });
  expect(rules()[0]).toMatchObject({ spread: true, spreadAmount: 4250, spreadGapDays: 30 });
});

it('a create while the Rules screen was never opened is a no-op on the (absent) cache — no crash, no phantom cache', async () => {
  // No ['rules'] seed: the query was never mounted, so getQueryData is undefined.
  queryClient.setQueryData(['categories'], []);
  server.once('POST', '/rules', { body: { id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' } });
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  // The server write still happened, but patchRules' `prev ? fn(prev) : prev` guard left the cache
  // untouched — no crash from spreading undefined, and no half-built ['rules'] cache.
  expect(server.requests()).toContainEqual({ method: 'POST', path: '/rules', body: { value: 'spotify', categoryId: 'subs', budgetExcluded: false, spread: false } });
  expect(queryClient.getQueryData(['rules'])).toBeUndefined();
});

// WHIT-540: editing the text mints a NEW id (the id IS the text). The optimistic map swaps r1 -> the
// saved id; skipRules must NOT invalidate ['rules'], or a refetch would race that swap.
// FAIL-ON-REVERT: drop skipRules and 'rules' shows up in the invalidated keys.
it('a successful text edit swaps the rule id in the cache and skipRules leaves it standing', async () => {
  seed([{ id: 'r1', pattern: 'COLES', categoryId: 'groceries', isNew: false, field: 'description', operator: 'contains' }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  server.once('PUT', '/rules/r1', { body: {
    id: 'coles-sydney', value: 'COLES SYDNEY', categoryId: 'groceries',
    field: 'description', operator: 'contains',
  } });
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.updateRule('r1', 'COLES SYDNEY', 'groceries'); });

  const keys = invalidatedKeys(spy);
  expect(keys).toContain('uncategorizedCount');    // re-file moved the tally
  expect(keys).not.toContain('rules');             // skipRules: the id-swap is not clobbered
  expect(rules()[0]).toMatchObject({ id: 'coles-sydney', pattern: 'COLES SYDNEY' });
  spy.mockRestore();
});

// WHIT-762: the exact optimistic row and API body for a multi-condition write, and for an edit that
// turns a multi rule back into a classic one.
const MULTI = {
  conditions: [
    { field: 'merchant', operator: 'equals', value: 'Coles' },
    { field: 'description', operator: 'contains', value: 'EXPRESS' },
  ],
  logic: 'all' as const,
};
const CLASSIC_R1 = { id: 'r1', pattern: 'OLD', categoryId: 'groceries', isNew: false, field: 'description', operator: 'contains' };
const MULTI_R1 = {
  id: 'r1', pattern: 'OLD', categoryId: 'groceries', isNew: false, budgetExcluded: false, spread: false,
  field: 'merchant', operator: 'equals', conditions: MULTI.conditions, logic: 'all',
};

it.each([
  {
    name: 'multi: the temp row carries the first condition + conditions/logic, and POSTs the conditions body',
    seeded: [],
    write: (ctx: ReturnType<typeof useAppContext>) => ctx.saveManualRule('ignored', 'groceries', false, MULTI, true),
    method: 'POST' as const, path: '/rules',
    row: {
      id: expect.stringMatching(/^tmp-/), isNew: true, pattern: 'Coles', categoryId: 'groceries', budgetExcluded: false, spread: true,
      field: 'merchant', operator: 'equals', conditions: MULTI.conditions, logic: 'all',
    },
    body: { conditions: MULTI.conditions, logic: 'all', categoryId: 'groceries', budgetExcluded: false, spread: true },
  },
  {
    name: 'multi: takes field/operator from the first condition and PUTs the conditions body (no field/operator)',
    seeded: [CLASSIC_R1],
    write: (ctx: ReturnType<typeof useAppContext>) => ctx.updateRule('r1', 'ignored', 'groceries', false, MULTI, false),
    method: 'PUT' as const, path: '/rules/r1',
    row: {
      ...CLASSIC_R1, pattern: 'Coles', budgetExcluded: false, spread: false,
      field: 'merchant', operator: 'equals', conditions: MULTI.conditions, logic: 'all',
    },
    body: { conditions: MULTI.conditions, logic: 'all', categoryId: 'groceries', budgetExcluded: false, spread: false },
  },
  {
    name: "classic: keeps the rule's field/operator, nulls conditions/logic, and PUTs them through",
    seeded: [MULTI_R1],
    write: (ctx: ReturnType<typeof useAppContext>) => ctx.updateRule('r1', ' NEW ', 'subs', true, undefined, true),
    method: 'PUT' as const, path: '/rules/r1',
    row: { ...MULTI_R1, pattern: 'NEW', categoryId: 'subs', budgetExcluded: true, spread: true, conditions: null, logic: null },
    body: { value: 'NEW', categoryId: 'subs', budgetExcluded: true, spread: true, field: 'merchant', operator: 'equals' },
  },
])('$name', async ({ seeded, write, method, path, row, body }) => {
  seed(seeded as Rule[]);
  const held = server.hold(path);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  let pending!: Promise<void>;
  act(() => { pending = write(result.current); });
  expect(rules()).toEqual([row]);

  await act(async () => { held.fail(method); await pending; });
  expect(server.sent(method, path).map((r) => r.body)).toEqual([body]);
});
