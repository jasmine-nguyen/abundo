// WHIT-559: a spread rule save can be refused for a reason the user can act on — 422 (no recurring
// bill matches yet) or 409 (the category already has a spread rule). Both writers surface the
// specific copy (driven by the ApiError status createRule/updateRule now throw); anything else keeps
// the generic toast. Drives the REAL writers via AppProvider + the singleton queryClient.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { Rule } from '../model';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { SUBS } from './support/categories';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const RULE_E1: Rule = { id: 'e1', pattern: 'ORIGIN', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' };
const rules = () => queryClient.getQueryData<Rule[]>(['rules']);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData<Rule[]>(['rules'], [RULE_E1]);
  queryClient.setQueryData(['categories'], [SUBS]);
  return renderHook(() => useAppContext(), { wrapper }).result;
}

// The spread copy is gated on the write actually REQUESTING spread ([A-G0]), so a non-spread 409
// stays generic. Fail-on-revert: drop the `spread &&` gate in ruleWriteErrorMessage and that row reddens.
it.each([
  ['a 422 on create shows the "no recurring bill" copy', 422, true, "We couldn't find a recurring bill matching this rule"],
  ['a 409 on create shows the "already has a spread rule" copy', 409, true, 'This category already has a spread rule'],
  ['a non-spread failure keeps the generic create toast', 400, true, 'Could not save rule. Please try again.'],
  ['[A-G0] a 409 on a NON-spread save keeps the generic toast', 409, false, 'Could not save rule. Please try again.'],
])('%s and rolls back', async (_name, status, spread, toast) => {
  server.fail('/rules', status);
  const result = mount();

  await act(async () => { await result.current.saveManualRule('ORIGIN', 'subs', false, undefined, spread); });

  expect(result.current.toast).toBe(toast);
  expect(rules()).toEqual([RULE_E1]);   // the optimistic row is rolled back
});

it('a 422 on an edit that turns spread on shows the specific copy too', async () => {
  server.fail('/rules/e1', 422);
  const result = mount();

  await act(async () => { await result.current.updateRule('e1', 'ORIGIN', 'subs', false, undefined, true); });

  expect(result.current.toast).toBe("We couldn't find a recurring bill matching this rule");
  expect(rules()?.[0]).toEqual(RULE_E1);   // rolled back to the original
});
