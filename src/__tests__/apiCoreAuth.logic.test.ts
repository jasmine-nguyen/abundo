// WHIT-110 gap tests, updated for WHIT-162 (static secret retired). Every app route
// is now guarded by the Cognito JWT authorizer, so the client authenticates with
// the ID token (getAuthToken). This file locks:
//  (1) the no-session contract for EVERY exported api.ts fetcher — read AND write —
//      so no function can silently send an empty Bearer and 401 instead of failing;
//  (2) proof the token is read PER CALL (getAuthToken invoked each time), not frozen.
// '../auth' and fetch are mocked; no network.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule());

import { getAuthToken } from '../auth';
import {
  fetchTransactions, fetchCategories, createCategory, updateCategory, deleteCategory,
  fetchBudgets, fetchBreakdown, setTransactionCategory, setTransactionCategories,
  fetchPayCycle, setPayCycle, setBudget, deleteBudget, fetchHomeLoan, fetchRepayment,
  fetchLoanFacts, setLoanFacts, listRules, createRule, updateRule,
  deleteRule, fetchAiInsights, generateAiInsights, registerDevice,
} from '../api';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  mockGetAuthToken.mockReset();
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

// One call per exported fetcher. If any forgot the auth gate it would call fetch with
// an empty Bearer instead of throwing — this table catches that for all of them.
const ALL_FETCHERS: [string, () => Promise<unknown>][] = [
  ['fetchTransactions', () => fetchTransactions()],
  ['fetchCategories', () => fetchCategories()],
  ['createCategory', () => createCategory({ name: 'Gym', bucket: 'Lifestyle' as any, icon: 'x' })],
  ['updateCategory', () => updateCategory('groceries', { name: 'G', bucket: 'Living' as any, icon: 'x' })],
  ['deleteCategory', () => deleteCategory('groceries')],
  ['fetchBudgets', () => fetchBudgets()],
  ['fetchBreakdown', () => fetchBreakdown()],
  ['setTransactionCategory', () => setTransactionCategory('t1', 'coffee')],
  ['setTransactionCategories', () => setTransactionCategories([{ id: 't1', category: 'coffee' }])],
  ['fetchPayCycle', () => fetchPayCycle()],
  ['setPayCycle', () => setPayCycle({ length: 14, last_pay_date: '2026-06-06' })],
  ['setBudget', () => setBudget('groceries', 300)],
  ['deleteBudget', () => deleteBudget('groceries')],
  ['fetchHomeLoan', () => fetchHomeLoan()],
  ['fetchRepayment', () => fetchRepayment()],
  ['fetchLoanFacts', () => fetchLoanFacts()],
  ['setLoanFacts', () => setLoanFacts({ original: 1, homeValue: 1, lvr: 0.1, ratePct: 1, baseRepay: 1, extra: 0 })],
  ['listRules', () => listRules()],
  ['createRule', () => createRule({ value: 'X', categoryId: 'c' })],
  ['updateRule', () => updateRule('e1', { value: 'X', categoryId: 'c' })],
  ['deleteRule', () => deleteRule('e1')],
  ['fetchAiInsights', () => fetchAiInsights()],
  ['generateAiInsights', () => generateAiInsights()],
  ['registerDevice', () => registerDevice('ExpoPushToken[x]')],
];

describe('every fetcher fails loudly with no Cognito session (WHIT-162)', () => {
  it.each(ALL_FETCHERS)(
    '%s throws "Not signed in" and never calls fetch',
    async (_name, call) => {
      mockGetAuthToken.mockResolvedValue(undefined);
      await expect(call()).rejects.toThrow('Not signed in');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

it('each call reads a fresh token and calls never share headers', async () => {
  fetchMock.mockReturnValue(okJson([]));
  mockGetAuthToken.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
  await createCategory({ name: 'Gym', bucket: 'Lifestyle' as any, icon: 'dumbbell' });
  await fetchCategories();
  expect((fetchMock.mock.calls[0][1] as any).headers).toEqual({ Authorization: 'Bearer first', 'Content-Type': 'application/json' });
  expect((fetchMock.mock.calls[1][1] as any).headers).toEqual({ Authorization: 'Bearer second' });
});
