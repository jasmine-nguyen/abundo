// WHIT-559: a spread rule save can be refused for a reason the user can act on — 422 (no recurring
// bill matches yet) or 409 (the category already has a spread rule). Both writers surface the
// specific copy (driven by the ApiError status createRule/updateRule now throw); anything else keeps
// the generic toast. Drives the REAL writers via AppProvider + the singleton queryClient.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { Rule } from '../context';
import { queryClient } from '../queryClient';
import { ApiError } from '../apiError';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;
const RULE_E1: Rule = { id: 'e1', pattern: 'ORIGIN', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };
const rules = () => queryClient.getQueryData<Rule[]>(['rules']);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]);
  queryClient.setQueryData(['categories'], [{ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 }]);
  return renderHook(() => useAppContext(), { wrapper }).result;
}

it('a 422 on create shows the "no recurring bill" copy and rolls back', async () => {
  mockApi.createRule.mockRejectedValue(new ApiError(422, null));
  const result = mount();

  await act(async () => { await result.current.saveManualRule('ORIGIN', 'subs', false, undefined, true); });

  expect(result.current.toast).toBe("We couldn't find a recurring bill matching this rule");
  expect(rules()).toEqual([RULE_E1]);   // the optimistic row is rolled back
});

it('a 409 on create shows the "already has a spread rule" copy', async () => {
  mockApi.createRule.mockRejectedValue(new ApiError(409, null));
  const result = mount();

  await act(async () => { await result.current.saveManualRule('ORIGIN', 'subs', false, undefined, true); });

  expect(result.current.toast).toBe('This category already has a spread rule');
});

it('a non-spread failure keeps the generic create toast', async () => {
  mockApi.createRule.mockRejectedValue(new ApiError(400, null));
  const result = mount();

  await act(async () => { await result.current.saveManualRule('ORIGIN', 'subs', false, undefined, true); });

  expect(result.current.toast).toBe('Could not save rule. Please try again.');
});

it('a 422 on an edit that turns spread on shows the specific copy too', async () => {
  mockApi.updateRule.mockRejectedValue(new ApiError(422, null));
  const result = mount();

  await act(async () => { await result.current.updateRule('e1', 'ORIGIN', 'subs', false, undefined, true); });

  expect(result.current.toast).toBe("We couldn't find a recurring bill matching this rule");
  expect(rules()?.[0]).toEqual(RULE_E1);   // rolled back to the original
});
