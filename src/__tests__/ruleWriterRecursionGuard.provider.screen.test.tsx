// WHIT-534 — regression guard for the Enrichment→Rule rename. The store writers
// deleteRule/updateRule share a NAME with the api functions, so context.tsx imports the
// api ones aliased (apiUpdateRule/apiDeleteRule). If that alias regressed to a plain
// import the writer would shadow-call ITSELF instead of the API (self-recursion), or a
// mis-alias would make it call the WRONG api fn. These assert each writer hits its own
// api fn EXACTLY ONCE and touches no sibling rule api. [A-recursion]
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
const NETFLIX: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };

function seed(seedRules: Rule[] = []) {
  queryClient.setQueryData(['rules'], seedRules);
  queryClient.setQueryData(['categories'], []);
}

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('deleteRule writer calls the api deleteRule exactly once and no other rule api', async () => {
  mockApi.deleteRule.mockResolvedValue({ id: 'e1' });
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.deleteRule('e1'); });

  // Exactly once → a self-recursing writer would never reach the api (0 calls); a stacked
  // double-write would be >1. Either fails this.
  expect(mockApi.deleteRule).toHaveBeenCalledTimes(1);
  expect(mockApi.deleteRule).toHaveBeenCalledWith('e1');
  // A mis-alias (writer calling the wrong api fn) is caught here.
  expect(mockApi.updateRule).not.toHaveBeenCalled();
  expect(mockApi.createRule).not.toHaveBeenCalled();
});

it('updateRule writer calls the api updateRule exactly once and no other rule api', async () => {
  mockApi.updateRule.mockResolvedValue({ id: 'e1', field: 'description', operator: 'contains', value: 'SPOTIFY', categoryId: 'subs' });
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.updateRule('e1', 'SPOTIFY', 'subs'); });

  expect(mockApi.updateRule).toHaveBeenCalledTimes(1);
  expect(mockApi.updateRule).toHaveBeenCalledWith('e1', { value: 'SPOTIFY', categoryId: 'subs', field: 'description', operator: 'contains', budgetExcluded: false });
  expect(mockApi.deleteRule).not.toHaveBeenCalled();
  expect(mockApi.createRule).not.toHaveBeenCalled();
});

it('saveManualRule writer calls the api createRule exactly once and no other rule api', async () => {
  mockApi.createRule.mockResolvedValue({ id: 'e9', field: 'description', operator: 'contains', value: 'spotify', categoryId: 'subs' });
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(mockApi.createRule).toHaveBeenCalledTimes(1);
  expect(mockApi.createRule).toHaveBeenCalledWith({ value: 'spotify', categoryId: 'subs', budgetExcluded: false });
  expect(mockApi.updateRule).not.toHaveBeenCalled();
  expect(mockApi.deleteRule).not.toHaveBeenCalled();
});
