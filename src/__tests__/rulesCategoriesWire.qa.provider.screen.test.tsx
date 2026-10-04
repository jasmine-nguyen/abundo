// WHIT-650 QA: the rule and category writers through the REAL request step (src/api.ts) on the fake
// server — the parts the auto-mock could never reach: the sign-in token, the path escaping, the
// request time limit, and how each error style (plain / statusOnly / withReason) reaches the toast.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Category } from '../types';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { resetAuth, setAuthToken } from './support/authMock';
import { SUBS } from './support/categories';

const server = installFakeServer();

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;
const NETFLIX: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };
const rules = () => queryClient.getQueryData<Rule[]>(['rules']);
const categoryIds = () => queryClient.getQueryData<Category[]>(['categories'])?.map((c) => c.id);

function mount(seedRules: Rule[] = [NETFLIX]) {
  queryClient.setQueryData<Rule[]>(['rules'], seedRules);
  queryClient.setQueryData<Category[]>(['categories'], [SUBS]);
  return renderHook(() => useAppContext(), { wrapper }).result;
}

beforeEach(() => { resetAuth(); queryClient.clear(); });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

// [A6]
it('with no sign-in token a new rule is never sent, and the optimistic rule is rolled back', async () => {
  setAuthToken(undefined);
  const result = mount();

  await act(async () => { await result.current.saveManualRule('spotify', 'subs'); });

  expect(server.requests()).toEqual([]);
  expect(rules()).toEqual([NETFLIX]);
  expect(result.current.toast).toBe('Could not save rule. Please try again.');
});

// [A7]
it('a rule id with a slash is escaped in the path, so the edit reaches that rule', async () => {
  const slashed: Rule = { ...NETFLIX, id: 'a/b' };
  const result = mount([slashed]);

  await act(async () => { await result.current.updateRule('a/b', 'DISNEY', 'subs'); });

  expect(server.requests()).toEqual([{
    method: 'PUT',
    path: '/rules/a%2Fb',
    body: { value: 'DISNEY', categoryId: 'subs', field: 'description', operator: 'contains', budgetExcluded: false, spread: false },
  }]);
  expect(rules()?.[0]).toMatchObject({ id: 'a/b', pattern: 'DISNEY' });
});

// [A8]
it('a delete refused with no reason in the body falls back to the generic toast and puts the category back', async () => {
  server.once('DELETE', '/categories/subs', { status: 400 });
  const result = mount();

  let ok!: boolean;
  await act(async () => { ok = await result.current.deleteCategory('subs'); });

  expect(ok).toBe(false);
  expect(result.current.toast).toBe('Could not delete category. Please try again.');
  expect(categoryIds()).toEqual(['subs']);
  expect(rules()).toEqual([NETFLIX]);
});

// [A9]
it('a spread rule save that loses its connection shows the generic copy, not the spread copy', async () => {
  server.once('POST', '/rules', 'dropped');
  const result = mount();

  await act(async () => { await result.current.saveManualRule('ORIGIN', 'subs', false, undefined, true); });

  expect(result.current.toast).toBe('Could not save rule. Please try again.');
  expect(rules()).toEqual([NETFLIX]);
});

// [A10]
it('a rule edit the server never answers is cut off after 15s and rolled back', async () => {
  jest.useFakeTimers();
  server.hold('/rules/e1');
  const result = mount();

  let pending!: Promise<void>;
  act(() => { pending = result.current.updateRule('e1', 'DISNEY', 'subs'); });
  expect(rules()?.[0].pattern).toBe('DISNEY'); // optimistic edit on screen
  for (let i = 0; i < 20 && server.requests().length === 0; i++) await Promise.resolve();
  expect(server.requests()).toHaveLength(1);

  await act(async () => { jest.advanceTimersByTime(14_999); });
  expect(rules()?.[0].pattern).toBe('DISNEY'); // still waiting just under the limit

  await act(async () => { jest.advanceTimersByTime(1); await pending; });

  expect(rules()).toEqual([NETFLIX]);
  expect(result.current.toast).toBe('Could not update rule. Please try again.');
});

// [A11]
it('a failed rule delete is sent once and not retried', async () => {
  server.fail('/rules/e1', 500);
  const result = mount();

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(server.requests()).toEqual([{ method: 'DELETE', path: '/rules/e1', body: undefined }]);
  expect(rules()).toEqual([NETFLIX]);
});
