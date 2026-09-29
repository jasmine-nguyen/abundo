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

jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {}, getAuthToken: async () => 'test-id-token' }));
import { installFakeServer } from './support/fakeServer';

const server = installFakeServer();
// Every rule write the app sent with this method (POST = create, PUT = update, DELETE = delete).
const ruleWrites = (method: string) => server.requests().filter((r) => r.method === method && r.path.startsWith('/rules'));

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;
const NETFLIX: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };

function seed(seedRules: Rule[] = []) {
  queryClient.setQueryData(['rules'], seedRules);
  queryClient.setQueryData(['categories'], []);
}

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

it('deleteRule writer calls the api deleteRule exactly once and no other rule api', async () => {
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.deleteRule('e1'); });

  // Exactly once → a self-recursing writer would never reach the api (0 calls); a stacked
  // double-write would be >1. Either fails this.
  expect(ruleWrites('DELETE')).toHaveLength(1);
  expect(ruleWrites('DELETE')).toContainEqual({ method: 'DELETE', path: '/rules/e1', body: undefined });
  // A mis-alias (writer calling the wrong api fn) is caught here.
  expect(ruleWrites('PUT')).toHaveLength(0);
  expect(ruleWrites('POST')).toHaveLength(0);
});

it('updateRule writer calls the api updateRule exactly once and no other rule api', async () => {
  seed([{ ...NETFLIX }]);
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.updateRule('e1', 'SPOTIFY', 'subs'); });

  expect(ruleWrites('PUT')).toHaveLength(1);
  expect(ruleWrites('PUT')).toContainEqual({ method: 'PUT', path: '/rules/e1', body: { value: 'SPOTIFY', categoryId: 'subs', field: 'description', operator: 'contains', budgetExcluded: false, spread: false } });
  expect(ruleWrites('DELETE')).toHaveLength(0);
  expect(ruleWrites('POST')).toHaveLength(0);
});

it('saveManualRule writer calls the api createRule exactly once and no other rule api', async () => {
  seed();
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(ruleWrites('POST')).toHaveLength(1);
  expect(ruleWrites('POST')).toContainEqual({ method: 'POST', path: '/rules', body: { value: 'spotify', categoryId: 'subs', budgetExcluded: false, spread: false } });
  expect(ruleWrites('PUT')).toHaveLength(0);
  expect(ruleWrites('DELETE')).toHaveLength(0);
});
