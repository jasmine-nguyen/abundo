// WHIT-833 — gaps the shared save / delete helpers leave open in the existing suites.
// Those suites always seed the cache first; here the cache is cold (never loaded), which is
// what `wholeObjectSave`'s `empty` and `listRemoval`'s null-on-missing exist for.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import { EMPTY_LOAN_FACTS, type Rule } from '../model';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const mountAppContext = () => renderHook(() => useAppContext(), { wrapper }).result;

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

const FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };

// [A1] A failed save on a cold cache puts back the form's empty default, not the unsaved value.
it.each([
  {
    name: 'saveLoanFacts', path: '/loanfacts', key: ['loanFacts'], expected: EMPTY_LOAN_FACTS,
    toast: 'Could not save loan details. Please try again.',
    run: (ctx: ReturnType<typeof useAppContext>) => ctx.saveLoanFacts(FACTS),
  },
  {
    name: 'saveMilestones', path: '/milestones', key: ['milestones'], expected: [],
    toast: 'Could not save milestones. Please try again.',
    run: (ctx: ReturnType<typeof useAppContext>) => ctx.saveMilestones(SAVED_MILESTONES),
  },
])('$name failure on a never-loaded cache rolls back to the empty default and toasts', async ({ path, key, expected, toast, run }) => {
  server.fail(path, 500);
  const result = mountAppContext();
  expect(queryClient.getQueryData(key)).toBeUndefined();

  let ok: boolean | undefined;
  await act(async () => { ok = await run(result.current); });

  expect(ok).toBe(false);
  expect(queryClient.getQueryData(key)).toEqual(expected);
  expect(result.current.toast).toBe(toast);
});

// [A2] deleteRule for an id that isn't cached sends nothing and leaves the list alone.
it('deleteRule for an id not in the cache is a no-op: no DELETE, cache untouched', async () => {
  const rules: Rule[] = [{ id: 'r1', pattern: 'r1', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' }];
  queryClient.setQueryData<Rule[]>(['rules'], rules);
  const result = mountAppContext();

  await act(async () => { await result.current.deleteRule('nope'); });

  expect(server.sentUnder('DELETE', '/rules/')).toEqual([]);
  expect(queryClient.getQueryData<Rule[]>(['rules'])).toEqual(rules);
});
