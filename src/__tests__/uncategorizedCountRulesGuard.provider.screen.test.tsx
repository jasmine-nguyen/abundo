// WHIT-502 / WHIT-540 — which rule writers move the whole-history uncategorized tally.
//
// CREATE (saveManualRule) still must NOT invalidate ['uncategorizedCount']: a NEW rule only labels
// FUTURE charges (BankSync applies rules at sync time), so it changes no stored charge's category —
// invalidating would fire a pointless refetch of an unchanged number on every rule save.
//
// EDIT and DELETE now DO (WHIT-540): editing a rule re-files the stored charges it already filed,
// and deleting one undoes them, so the server-derived tally genuinely moves and must be refreshed.
// The two writers reuse refreshAfterApplyRules({ skipRules: true }), which invalidates
// ['uncategorizedCount'] (among the other server-derived reads) but leaves ['rules'] alone.
//
// Fail-on-revert: saveManualRule flips RED if an invalidate is cargo-culted back in; updateRule /
// deleteRule flip RED if their refresh is dropped.
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

it('saveManualRule does NOT invalidate uncategorizedCount (a new rule labels only future charges)', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.saveManualRule('WOOLWORTHS', 'groceries'); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  spy.mockRestore();
});

it('updateRule invalidates uncategorizedCount but not rules (WHIT-540 re-files stored charges)', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.updateRule('r1', 'COLES SYDNEY', 'groceries'); });

  const keys = invalidatedKeys(spy);
  expect(keys).toContain('uncategorizedCount');   // the re-file moved the tally
  expect(keys).not.toContain('rules');             // skipRules: the optimistic edit already patched it
  spy.mockRestore();
});

it('deleteRule invalidates uncategorizedCount but not rules (WHIT-540 undoes stored charges)', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteRule('r1'); });

  const keys = invalidatedKeys(spy);
  expect(keys).toContain('uncategorizedCount');
  expect(keys).not.toContain('rules');
  spy.mockRestore();
});
