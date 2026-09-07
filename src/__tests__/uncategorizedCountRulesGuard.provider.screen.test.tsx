// WHIT-502 — GUARD: the three rule writers (saveManualRule / updateRule / deleteRule) must NOT
// invalidate ['uncategorizedCount']. A categorisation rule only labels FUTURE charges (BankSync
// applies rules at sync time; our /enrichments endpoints pure-proxy to BankSync and write zero
// transaction rows), so saving/editing/deleting a rule changes no stored charge's category — the
// whole-history tally can't move. Invalidating here would fire a pointless refetch of an unchanged
// number on every rule save. Any later bank-side re-tag arrives via the webhook, already covered by
// the count's staleTime + pull-to-refresh.
//
// Fail-on-revert (regression guard, the mirror of the applyTransactionEdit negative in
// uncategorizedCountInvalidation): ADD an invalidateQueries({ queryKey: ['uncategorizedCount'] }) to
// any of these three writers and its test flips RED. Spike WHIT-502 verified the server does no
// retroactive re-tag; these lock that verdict so a future change can't quietly cargo-cult it back in.
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
const ENRICHMENT = { id: 'r1', value: 'COLES', categoryId: 'groceries', field: 'description', operator: 'contains' } as const;

function invalidatedKeys(spy: ReturnType<typeof jest.spyOn>) {
  return spy.mock.calls.map((c: unknown[]) => (c[0] as { queryKey: string[] }).queryKey[0]);
}

beforeEach(() => {
  queryClient.clear();
  mockApi.createEnrichment.mockResolvedValue({ ...ENRICHMENT } as never);
  mockApi.updateEnrichment.mockResolvedValue({ ...ENRICHMENT } as never);
  mockApi.deleteEnrichment.mockResolvedValue(undefined as never);
});
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData(['categories'], [{ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 }]);
  queryClient.setQueryData(['rules'], [{ ...RULE }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saveManualRule does NOT invalidate uncategorizedCount', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.saveManualRule('WOOLWORTHS', 'groceries'); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  spy.mockRestore();
});

it('updateRule does NOT invalidate uncategorizedCount', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.updateRule('r1', 'COLES SYDNEY', 'groceries'); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  spy.mockRestore();
});

it('deleteRule does NOT invalidate uncategorizedCount', async () => {
  const result = mount();
  const spy = jest.spyOn(queryClient, 'invalidateQueries');

  await act(async () => { await result.current.deleteRule('r1'); });

  expect(invalidatedKeys(spy)).not.toContain('uncategorizedCount');
  spy.mockRestore();
});
