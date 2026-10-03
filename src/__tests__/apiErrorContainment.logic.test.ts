// WHIT-437 / WHIT-631 — [A10][A11][A12] containment: every endpoint in src/api.ts DECLARES its
// error style next to itself (`api.<name>.errors`), and this sweep checks each one behaves as it
// says. `failed()` (the server's reason) reaches only the three category writes, and
// `API error: N` stays byte-identical on every endpoint.
//
// Nothing else stops a later edit from (a) folding the server's words INTO the message — which
// would feed arbitrary server text to src/queryClient.ts's /\b40[13]\b/ auth-retry match and to
// ~99 message assertions — or (b) quietly widening `failed()` to an endpoint whose 4xx bodies were
// never reviewed for user-facing wording. This sweeps every exported endpoint against a not-OK
// response that DOES carry an `error` body.
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

type ErrorHandling = 'plain' | 'statusOnly' | 'withReason';
const ERROR_STYLES: readonly ErrorHandling[] = ['plain', 'statusOnly', 'withReason'];

/** The error style an endpoint declares next to itself in src/api.ts. */
function declaredErrors(name: string): unknown {
  return (api as unknown as Record<string, { errors?: unknown }>)[name].errors;
}

// Every exported endpoint with plausible arguments. Keyed by name so the tripwire below can
// prove none was skipped (and that a NEW endpoint can't be added without a decision here).
const CALLS: Record<string, () => Promise<unknown>> = {
  fetchTransactions: () => api.fetchTransactions(),
  fetchTransactionsFeed: () => api.fetchTransactionsFeed('cur', 25),
  fetchUncategorizedFeed: () => api.fetchUncategorizedFeed('cur', 25), // a read → generic error, NOT a reason-carrying write
  fetchTransactionsSearch: () => api.fetchTransactionsSearch('all', 'steven'), // WHIT-576: a read → generic error, NOT a reason-carrying write
  fetchUncategorizedCount: () => api.fetchUncategorizedCount(), // WHIT-501: a read → generic error, NOT a reason-carrying write
  fetchUncategorizedMerchants: () => api.fetchUncategorizedMerchants(), // WHIT-517: a read → generic error, NOT a reason-carrying write
  fetchFilingSuggestions: () => api.fetchFilingSuggestions(), // WHIT-542: a read → generic error, NOT a reason-carrying write
  // WHIT-508/WHIT-517: a write. It throws an ApiError so "file by shop" can read the 409 clash
  // STATUS — but with serverMessage NULL, deliberately: its 4xx wording ("dryRun must be a
  // boolean") and 502 BankSync internals are never shown, so the body is never carried. The sheet's
  // own phase-specific + clash copy is what the user reads. Declared statusOnly in src/api.ts.
  applyRulesToUncategorized: () => api.applyRulesToUncategorized(true),
  // WHIT-560: the async apply-rules job endpoints. Both throw an ApiError to expose the STATUS
  // (start reads a 409 clash; get reads a 404 expired id) but carry NO server reason — statusOnly.
  startApplyRulesJob: () => api.startApplyRulesJob(),
  getApplyRulesJob: () => api.getApplyRulesJob('j1'),
  // Card 609: the Ask Abundo chat job endpoints — same job pattern, status only (the chat reads a
  // 404 as an expired job).
  startAiChat: () => api.startAiChat([{ role: 'user', text: 'How much on coffee?' }]),
  getAiChatJob: () => api.getAiChatJob('c1'),
  fetchCategories: () => api.fetchCategories(),
  createCategory: () => api.createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }),
  updateCategory: () => api.updateCategory('gym', { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }),
  deleteCategory: () => api.deleteCategory('gym'),
  fetchBudgets: () => api.fetchBudgets(14),
  fetchBudgetTransactions: () => api.fetchBudgetTransactions('groceries'),
  fetchBreakdown: () => api.fetchBreakdown(14, 1),
  fetchCategoryTransactions: () => api.fetchCategoryTransactions('groceries', 0),
  fetchCycleTransactions: () => api.fetchCycleTransactions(0),
  setTransactionCategory: () => api.setTransactionCategory('t1', 'groceries'),
  setTransactionFields: () => api.setTransactionFields('t1', { notes: 'n' }),
  deleteTransaction: () => api.deleteTransaction('t1'),
  setTransactionCategories: () => api.setTransactionCategories([{ id: 't1', category: 'groceries' }]),
  fetchHomeLoan: () => api.fetchHomeLoan(),
  fetchAccountBalances: () => api.fetchAccountBalances(),
  refreshAccountBalances: () => api.refreshAccountBalances(),
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
  setSpread: () => api.setSpread('groceries', 100, 3),
  deleteSpread: () => api.deleteSpread('groceries'),
  listRules: () => api.listRules(),
  createRule: () => api.createRule({ value: 'COLES', categoryId: 'groceries' }),
  updateRule: () => api.updateRule('r1', { value: 'COLES', categoryId: 'groceries' }),
  deleteRule: () => api.deleteRule('r1'),
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
    // If this fails you added an endpoint: add it to CALLS, and declare its error style next to it
    // in src/api.ts — deliberately, not by copying a neighbour.
    expect(exported).toEqual([...NAMES].sort());
  });
});

describe('[A12b] every endpoint declares its error style', () => {
  it.each(NAMES)('%s has an errors label', (name) => {
    expect(ERROR_STYLES).toContain(declaredErrors(name));
  });

  it('only the three category writes carry the server reason', () => {
    // Deliberate pin: widening failed() to another endpoint makes its 4xx wording user-facing copy.
    // That is a product decision, so it must edit this line on purpose.
    expect(NAMES.filter((name) => declaredErrors(name) === 'withReason').sort())
      .toEqual(['createCategory', 'deleteCategory', 'updateCategory']);
  });
});

describe('[A13] every request sends the sign-in header, and Content-Type only with a body', () => {
  it.each(NAMES)('%s', async (name) => {
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ count: 0 }) }));
    await CALLS[name]().catch(() => undefined);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string>; body?: unknown };
    expect('Content-Type' in init.headers).toBe(init.body !== undefined);
    expect(init.headers.Authorization).toBe('Bearer tok');
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

describe('[A11] a failed response behaves as the endpoint declares', () => {
  it.each(NAMES)('%s follows its declared errors label', async (name) => {
    const error = (await CALLS[name]().then(() => null, (e: unknown) => e)) as Error & {
      serverMessage?: string | null;
    };
    const errors = declaredErrors(name);
    if (errors === 'withReason') {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.serverMessage).toBe(LEAK);
    } else if (errors === 'statusOnly') {
      // An ApiError for its STATUS (e.g. a 409 clash or 404 expired job drives control flow), but
      // the body is deliberately NOT carried — the server's wording is never shown.
      expect(error).toBeInstanceOf(ApiError);
      expect(error.serverMessage).toBeNull();
      expect((error as Error).message).not.toContain(LEAK);
    } else {
      expect(errors).toBe('plain');
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
