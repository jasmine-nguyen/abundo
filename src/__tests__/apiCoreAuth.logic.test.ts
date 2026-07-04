// WHIT-110 gap tests. apiCore.logic.test.ts locks the Bearer header on each fetcher
// and the missing-token throw for fetchTransactions only. This file adds:
//  (1) the missing-token contract for EVERY exported api.ts fetcher — read AND write —
//      so no function can silently send `Bearer undefined` and 401 instead of failing;
//  (2) proof the token is read PER CALL (not frozen at module load), guarding the
//      call-time-read design api.ts's comment depends on.
// fetch is mocked; no network.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  fetchTransactions, fetchCategories, createCategory, updateCategory, deleteCategory,
  fetchBudgets, fetchBreakdown, setTransactionCategory, setTransactionCategories,
  fetchPayCycle, setPayCycle, setBudget, fetchHomeLoan, fetchRepayment,
  fetchLoanFacts, setLoanFacts, listEnrichments, createEnrichment, updateEnrichment,
  deleteEnrichment, fetchAiInsights, generateAiInsights, registerDevice,
} from '../api';

const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_TOKEN;
});

// One call per exported fetcher. If any forgot the token gate it would call fetch with
// `Bearer undefined` instead of throwing — this table catches that for all of them.
const ALL_FETCHERS: [string, () => Promise<unknown>][] = [
  ['fetchTransactions', () => fetchTransactions()],
  ['fetchCategories', () => fetchCategories()],
  ['createCategory', () => createCategory({ name: 'Gym', bucket: 'Lifestyle' as any, icon: 'x' })],
  ['updateCategory', () => updateCategory('groceries', { name: 'G', bucket: 'Living' as any, icon: 'x' })],
  ['deleteCategory', () => deleteCategory('groceries')],
  ['fetchBudgets', () => fetchBudgets(14)],
  ['fetchBreakdown', () => fetchBreakdown(14)],
  ['setTransactionCategory', () => setTransactionCategory('t1', 'coffee')],
  ['setTransactionCategories', () => setTransactionCategories([{ id: 't1', category: 'coffee' }])],
  ['fetchPayCycle', () => fetchPayCycle()],
  ['setPayCycle', () => setPayCycle({ length: 14, last_pay_date: '2026-06-06' })],
  ['setBudget', () => setBudget('groceries', 300)],
  ['fetchHomeLoan', () => fetchHomeLoan()],
  ['fetchRepayment', () => fetchRepayment()],
  ['fetchLoanFacts', () => fetchLoanFacts()],
  ['setLoanFacts', () => setLoanFacts({ original: 1, homeValue: 1, lvr: 0.1, ratePct: 1, baseRepay: 1, extra: 0 })],
  ['listEnrichments', () => listEnrichments()],
  ['createEnrichment', () => createEnrichment({ value: 'X', categoryId: 'c' })],
  ['updateEnrichment', () => updateEnrichment('e1', { value: 'X', categoryId: 'c' })],
  ['deleteEnrichment', () => deleteEnrichment('e1')],
  ['fetchAiInsights', () => fetchAiInsights()],
  ['generateAiInsights', () => generateAiInsights()],
  ['registerDevice', () => registerDevice('ExpoPushToken[x]')],
];

describe('every gated fetcher fails loudly when the token is missing (WHIT-110)', () => {
  it.each(ALL_FETCHERS)(
    '%s throws Missing EXPO_PUBLIC_API_TOKEN and never calls fetch',
    async (_name, call) => {
      delete process.env.EXPO_PUBLIC_API_TOKEN;
      await expect(call()).rejects.toThrow('Missing EXPO_PUBLIC_API_TOKEN');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('the token is read per-call, not frozen at module load', () => {
  it('uses the CURRENT EXPO_PUBLIC_API_TOKEN value on each call', async () => {
    fetchMock.mockReturnValue(okJson([]));

    process.env.EXPO_PUBLIC_API_TOKEN = 'token-A';
    await fetchTransactions();
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer token-A');
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/transactions`);

    process.env.EXPO_PUBLIC_API_TOKEN = 'token-B';
    await fetchTransactions();
    expect((fetchMock.mock.calls[1][1] as any).headers.Authorization).toBe('Bearer token-B');
  });
});
