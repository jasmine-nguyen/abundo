// WHIT-437 — [A10][A11][A12] containment: `failed()` reaches the THREE category writes and
// nothing else, and `API error: N` stays byte-identical on ALL 34 endpoints.
//
// The card only rewired 3 of 33 not-OK guards. Nothing in the codebase stops a later edit from
// (a) folding the server's words INTO the message — which would feed arbitrary server text to
// src/queryClient.ts's /\b40[13]\b/ auth-retry match and to ~99 message assertions — or
// (b) quietly widening `failed()` to an endpoint whose 4xx bodies were never reviewed for
// user-facing wording. This sweeps every exported endpoint against a not-OK response that DOES
// carry an `error` body and pins exactly who is allowed to see it.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));

import { getAuthToken } from '../auth';
import * as api from '../api';
import { ApiError } from '../apiError';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
let fetchMock: jest.Mock;

// 418 is deliberately a status no endpoint special-cases, and LEAK is deliberately not a real
// message: if it ever shows up in an error's `message`, something folded the body into the text.
const STATUS = 418;
const LEAK = 'LEAKED SERVER REASON';

beforeEach(() => {
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockResolvedValue('tok');
  fetchMock = jest.fn(() =>
    Promise.resolve({ ok: false, status: STATUS, json: () => Promise.resolve({ error: LEAK }) }));
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

/** The three writes the card rewired — the ONLY endpoints allowed to carry a server reason. */
const REASON_CARRYING = ['createCategory', 'updateCategory', 'deleteCategory'] as const;

// Every exported endpoint with plausible arguments. Keyed by name so the tripwire below can
// prove none was skipped (and that a NEW endpoint can't be added without a decision here).
const CALLS: Record<string, () => Promise<unknown>> = {
  fetchTransactions: () => api.fetchTransactions(),
  fetchTransactionsFeed: () => api.fetchTransactionsFeed('cur', 25),
  fetchCategories: () => api.fetchCategories(),
  createCategory: () => api.createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }),
  updateCategory: () => api.updateCategory('gym', { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }),
  deleteCategory: () => api.deleteCategory('gym'),
  fetchBudgets: () => api.fetchBudgets(14),
  fetchBudgetTransactions: () => api.fetchBudgetTransactions('groceries'),
  fetchBreakdown: () => api.fetchBreakdown(14, 1),
  fetchCategoryTransactions: () => api.fetchCategoryTransactions('groceries', 0),
  setTransactionCategory: () => api.setTransactionCategory('t1', 'groceries'),
  setTransactionFields: () => api.setTransactionFields('t1', { notes: 'n' }),
  setTransactionCategories: () => api.setTransactionCategories([{ id: 't1', category: 'groceries' }]),
  fetchHomeLoan: () => api.fetchHomeLoan(),
  fetchAccountBalances: () => api.fetchAccountBalances(),
  fetchGoals: () => api.fetchGoals(),
  fetchMilestones: () => api.fetchMilestones(),
  setMilestones: () => api.setMilestones([]),
  saveGoal: () => api.saveGoal('g1', {} as Parameters<typeof api.saveGoal>[1]),
  deleteGoal: () => api.deleteGoal('g1'),
  fetchRepayment: () => api.fetchRepayment(),
  fetchLoanFacts: () => api.fetchLoanFacts(),
  setLoanFacts: () => api.setLoanFacts({} as Parameters<typeof api.setLoanFacts>[0]),
  fetchPayCycle: () => api.fetchPayCycle(),
  setPayCycle: () => api.setPayCycle({ length: 14, last_pay_date: '2026-07-01' }),
  setBudget: () => api.setBudget('groceries', 100),
  deleteBudget: () => api.deleteBudget('groceries'),
  listEnrichments: () => api.listEnrichments(),
  createEnrichment: () => api.createEnrichment({ value: 'COLES', categoryId: 'groceries' }),
  updateEnrichment: () => api.updateEnrichment('r1', { value: 'COLES', categoryId: 'groceries' }),
  deleteEnrichment: () => api.deleteEnrichment('r1'),
  fetchAiInsights: () => api.fetchAiInsights(),
  generateAiInsights: () => api.generateAiInsights(null),
  registerDevice: () => api.registerDevice('ExpoPushToken[abc]'),
};

const NAMES = Object.keys(CALLS);

describe('[A12] the sweep really covers every endpoint', () => {
  it('has a call for every exported function in src/api.ts', () => {
    // ApiError is a re-exported CLASS, not an endpoint.
    const exported = Object.entries(api)
      .filter(([name, value]) => typeof value === 'function' && name !== 'ApiError')
      .map(([name]) => name)
      .sort();
    // If this fails you added an endpoint: add it to CALLS and decide, deliberately, whether it
    // may quote the server (see WHIT-437's follow-up card) — don't just append it to the list.
    expect(exported).toEqual([...NAMES].sort());
  });
});

describe('[A10] every endpoint keeps the byte-identical `API error: N`', () => {
  it.each(NAMES)('%s', async (name) => {
    const error = await CALLS[name]().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // The message must NOT have grown the body. queryClient's /\b40[13]\b/ runs over exactly this.
    expect((error as Error).message).toBe(`API error: ${STATUS}`);
    expect((error as Error).message).not.toContain(LEAK);
  });
});

describe('[A11] the server body reaches only the three category writes', () => {
  it.each(NAMES)('%s exposes serverMessage only if it is a category write', async (name) => {
    const error = (await CALLS[name]().then(() => null, (e: unknown) => e)) as Error & {
      serverMessage?: string | null;
    };
    if ((REASON_CARRYING as readonly string[]).includes(name)) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.serverMessage).toBe(LEAK);
    } else {
      // Deliberate tripwire, not an accident: widening `failed()` to another endpoint is a
      // product decision (its 4xx wording becomes user-facing copy), so it must edit this list.
      expect(error).not.toBeInstanceOf(ApiError);
      expect(error.serverMessage).toBeUndefined();
    }
  });
});

describe('[A10b] the message survives a hostile body', () => {
  it.each([
    ['a body that looks like an auth error', { error: 'token 401 expired, re-auth at 403' }],
    ['a 2KB stack trace', { error: 'x'.repeat(2048) }],
    ['a newline-riddled body', { error: 'line one\nline two\r\nline three' }],
  ])('%s still yields API error: 418 with the body in its own field', async (_label, body) => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, status: STATUS, json: () => Promise.resolve(body) }));
    const error = (await CALLS.createCategory().then(() => null, (e: unknown) => e)) as ApiError;
    expect(error.message).toBe('API error: 418');
    expect(error.serverMessage).toBe((body as { error: string }).error);
  });
});
