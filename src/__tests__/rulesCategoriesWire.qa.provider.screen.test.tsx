// WHIT-650 QA: the rule and category writers through the REAL request step (src/api.ts) on the fake
// server — the parts the auto-mock could never reach: the sign-in token, the path escaping, and
// a failed delete that is not retried.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Category } from '../types';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { resetAuth, setAuthToken } from './support/authMock';
import { SUBS } from './support/categories';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const NETFLIX: Rule = { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };
const rules = () => queryClient.getQueryData<Rule[]>(['rules']);

function mount(seedRules: Rule[] = [NETFLIX]) {
  queryClient.setQueryData<Rule[]>(['rules'], seedRules);
  queryClient.setQueryData<Category[]>(['categories'], [SUBS]);
  return renderHook(() => useAppContext(), { wrapper }).result;
}

beforeEach(() => { resetAuth(); queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

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

// [A11]
it('a failed rule delete is sent once and not retried', async () => {
  server.fail('/rules/e1', 500);
  const result = mount();

  await act(async () => { await result.current.deleteRule('e1'); });

  expect(server.requests()).toEqual([{ method: 'DELETE', path: '/rules/e1', body: undefined }]);
  expect(rules()).toEqual([NETFLIX]);
});
