// WHIT-533 — the new /rules store may mint a NEW id when a rule's value changes (BankSync
// /rules kept the id). updateRule swaps by the OLD id (context.tsx ~1705) and must land
// the server's row — carrying its NEW id — in place, so a follow-up edit/delete can find it.
// Existing rulesWrite "updateRule edits the cached rule in place" returns the SAME id, so this
// id-changing path is uncovered. Same mock-by-function-name pattern as rulesWrite (URL-agnostic).
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

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mountWithSeededCache() {
  queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]);
  queryClient.setQueryData(['categories'], [{ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('updateRule adopts the server-assigned NEW id when the /rules store re-mints on a value change', async () => {
  // The server changed the id ('e1' -> 'e9') because the value changed — the /rules store's behaviour.
  mockApi.updateRule.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'DISNEY', categoryId: 'subs' });
  const result = mountWithSeededCache();

  await act(async () => { await result.current.updateRule('e1', 'DISNEY', 'subs'); });

  // The swap keyed on the OLD id lands the server row with its NEW id in place — not left at 'e1',
  // not duplicated. Left keyed wrong, the cache would keep the stale 'e1' row and a later delete/edit
  // would miss it.
  expect(cacheRules()).toHaveLength(1);
  expect(cacheRules()?.[0]).toEqual({ id: 'e9', pattern: 'DISNEY', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' });
});
