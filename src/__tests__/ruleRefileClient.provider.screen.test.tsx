// WHIT-540 gaps — the client re-file refresh, edges the guard suite skips:
//   * a FAILED edit / delete must NOT refresh the server-derived reads (the server wrote nothing),
//     and must roll the optimistic change back;
//   * a successful TEXT edit swaps the rule's id in the ['rules'] cache, and skipRules must leave
//     that swap standing (no ['rules'] refetch racing it).
// Modelled on uncategorizedCountRulesGuard.provider.screen.test.tsx.
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

const RULE: Rule = { id: 'r1', pattern: 'COLES', categoryId: 'groceries', isNew: false, field: 'description', operator: 'contains' };
const RULE_RECORD = { id: 'r1', value: 'COLES', categoryId: 'groceries', field: 'description', operator: 'contains' } as const;

function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}
function rulesCache() {
  return queryClient.getQueryData<Rule[]>(['rules']) ?? [];
}

beforeEach(() => {
  queryClient.clear();
  mockApi.createRule.mockResolvedValue({ ...RULE_RECORD } as never);
  mockApi.updateRule.mockResolvedValue({ ...RULE_RECORD } as never);
  mockApi.deleteRule.mockResolvedValue({ id: 'r1' } as never);
});
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData(['categories'], [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 }]);
  queryClient.setQueryData(['rules'], [{ ...RULE }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('updateRule that FAILS does not refresh the count and rolls the edit back', async () => {
  // The server never wrote (the PUT threw), so refreshing would refetch an UNCHANGED count and,
  // worse, could clobber the rolled-back rule row. The refresh sits AFTER the await inside the try,
  // so a reject skips it. FAIL-ON-REVERT: move refreshAfterApplyRules into a finally / before the
  // await and 'uncategorizedCount' appears here.
  const result = mount();
  mockApi.updateRule.mockRejectedValueOnce(new Error('500') as never);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.updateRule('r1', 'COLES SYDNEY', 'groceries'); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  expect(rulesCache()[0].pattern).toBe('COLES');   // optimistic edit rolled back
  expect(rulesCache()[0].id).toBe('r1');
  spy.mockRestore();
});

it('deleteRule that FAILS does not refresh the count and reinserts the rule', async () => {
  // FAIL-ON-REVERT: move the refresh out of the try and a failed delete refetches an unchanged
  // count (and the reinserted rule races a ['rules'] refetch).
  const result = mount();
  mockApi.deleteRule.mockRejectedValueOnce(new Error('500') as never);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteRule('r1'); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  expect(rulesCache().some((r) => r.id === 'r1')).toBe(true);   // reinserted on failure
  spy.mockRestore();
});

it('a successful text edit swaps the rule id in the cache and skipRules leaves it standing', async () => {
  // Editing the text mints a NEW id (the id IS the text). The optimistic map swaps r1 -> the saved
  // id; skipRules must NOT invalidate ['rules'], or a refetch would race that swap. FAIL-ON-REVERT:
  // drop skipRules and 'rules' shows up in the invalidated keys.
  const result = mount();
  mockApi.updateRule.mockResolvedValueOnce({
    id: 'coles-sydney', value: 'COLES SYDNEY', categoryId: 'groceries',
    field: 'description', operator: 'contains',
  } as never);
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.updateRule('r1', 'COLES SYDNEY', 'groceries'); });

  const keys = invalidatedKeys(spy);
  expect(keys).toContain('uncategorizedCount');    // re-file moved the tally
  expect(keys).not.toContain('rules');             // skipRules: the id-swap is not clobbered
  const row = rulesCache()[0];
  expect(row.id).toBe('coles-sydney');             // id swapped to the new text's id
  expect(row.pattern).toBe('COLES SYDNEY');
  spy.mockRestore();
});
