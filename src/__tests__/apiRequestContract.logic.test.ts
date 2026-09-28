// WHIT-631 QA — the one shared request step must keep every endpoint's wire contract. These pin, per
// endpoint, the method / path / time limit / body the old hand-written fetches sent, so a change to
// `request()` or to one endpoint's declaration can't quietly move them.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));

import { getAuthToken } from '../auth';
import * as api from '../api';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
const BASE = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';
let fetchMock: jest.Mock;
let timers: number[];
const realSetTimeout = global.setTimeout;

beforeEach(() => {
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockResolvedValue('tok');
  fetchMock = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ count: 0 }) }));
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  timers = [];
  // Record every timer's delay (the fetch abort timer, then the body-read timer) without firing it.
  (global as unknown as { setTimeout: unknown }).setTimeout = ((_fn: () => void, ms: number) => {
    timers.push(ms);
    return realSetTimeout(() => undefined, 0);
  }) as unknown;
});

afterEach(() => {
  (global as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
});

type Wire = [method: string | null, path: string, timeoutMs: number, body: string | undefined];

// [A1][A2][A3] Every endpoint's request, as the pre-WHIT-631 hand-written fetches sent it.
const WIRE: Record<string, [() => Promise<unknown>, Wire]> = {
  fetchTransactions: [() => api.fetchTransactions(), [null, '/transactions', 15000, undefined]],
  fetchTransactionsFeed: [() => api.fetchTransactionsFeed('cur', 25), [null, '/transactions/feed?cursor=cur&limit=25', 15000, undefined]],
  fetchUncategorizedFeed: [() => api.fetchUncategorizedFeed('cur', 25), [null, '/transactions/uncategorized/feed?cursor=cur&limit=25', 15000, undefined]],
  fetchTransactionsSearch: [() => api.fetchTransactionsSearch('all', 'steven'), [null, '/transactions/search?tab=all&q=steven', 30000, undefined]],
  fetchUncategorizedCount: [() => api.fetchUncategorizedCount(), [null, '/transactions/uncategorized/count', 15000, undefined]],
  fetchUncategorizedMerchants: [() => api.fetchUncategorizedMerchants(), [null, '/transactions/uncategorized/merchants', 30000, undefined]],
  fetchFilingSuggestions: [() => api.fetchFilingSuggestions(), [null, '/transactions/filing-suggestions', 30000, undefined]],
  applyRulesToUncategorized: [() => api.applyRulesToUncategorized(true), ['POST', '/transactions/uncategorized/apply-rules', 30000, '{"dryRun":true}']],
  startApplyRulesJob: [() => api.startApplyRulesJob(), ['POST', '/transactions/uncategorized/apply-rules/jobs', 15000, '{}']],
  getApplyRulesJob: [() => api.getApplyRulesJob('j1'), [null, '/transactions/uncategorized/apply-rules/jobs/j1', 6000, undefined]],
  startAiChat: [() => api.startAiChat([{ role: 'user', text: 'hi' }]), ['POST', '/ai/chat', 15000, '{"messages":[{"role":"user","text":"hi"}]}']],
  getAiChatJob: [() => api.getAiChatJob('c1'), [null, '/ai/chat/jobs/c1', 6000, undefined]],
  fetchCategories: [() => api.fetchCategories(), [null, '/categories', 15000, undefined]],
  createCategory: [() => api.createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }), ['POST', '/categories', 15000, '{"name":"Gym","bucket":"Lifestyle","icon":"dumbbell"}']],
  updateCategory: [() => api.updateCategory('gym', { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }), ['PATCH', '/categories/gym', 15000, '{"name":"Gym","bucket":"Lifestyle","icon":"dumbbell"}']],
  deleteCategory: [() => api.deleteCategory('gym'), ['DELETE', '/categories/gym', 15000, undefined]],
  fetchBudgets: [() => api.fetchBudgets(14), [null, '/budgets?days=14', 15000, undefined]],
  fetchBudgetTransactions: [() => api.fetchBudgetTransactions('groceries'), [null, '/budgets/groceries/transactions', 15000, undefined]],
  fetchBreakdown: [() => api.fetchBreakdown(14, 1), [null, '/breakdown?days=14&cycle=1', 15000, undefined]],
  fetchCategoryTransactions: [() => api.fetchCategoryTransactions('groceries', 0), [null, '/categories/groceries/transactions', 15000, undefined]],
  setTransactionCategory: [() => api.setTransactionCategory('t1', 'groceries'), ['PATCH', '/transactions/t1', 15000, '{"category":"groceries"}']],
  setTransactionFields: [() => api.setTransactionFields('t1', { notes: 'n' }), ['PATCH', '/transactions/t1', 15000, '{"notes":"n"}']],
  setTransactionCategories: [() => api.setTransactionCategories([{ id: 't1', category: 'groceries' }]), ['PATCH', '/transactions', 15000, '{"updates":[{"id":"t1","category":"groceries"}]}']],
  fetchHomeLoan: [() => api.fetchHomeLoan(), [null, '/homeloan', 15000, undefined]],
  fetchAccountBalances: [() => api.fetchAccountBalances(), [null, '/accounts/balances', 15000, undefined]],
  refreshAccountBalances: [() => api.refreshAccountBalances(), ['POST', '/accounts/balances/refresh', 30000, undefined]],
  fetchGoals: [() => api.fetchGoals(), [null, '/goals', 15000, undefined]],
  fetchMilestones: [() => api.fetchMilestones(), [null, '/milestones', 15000, undefined]],
  setMilestones: [() => api.setMilestones([]), ['PUT', '/milestones', 15000, '{"milestones":[]}']],
  saveGoal: [() => api.saveGoal('g1', {} as Parameters<typeof api.saveGoal>[1]), ['PUT', '/goals/g1', 15000, '{}']],
  deleteGoal: [() => api.deleteGoal('g1'), ['DELETE', '/goals/g1', 15000, undefined]],
  fetchRepayment: [() => api.fetchRepayment(), [null, '/repayment', 15000, undefined]],
  fetchLoanFacts: [() => api.fetchLoanFacts(), [null, '/loanfacts', 15000, undefined]],
  setLoanFacts: [() => api.setLoanFacts({} as Parameters<typeof api.setLoanFacts>[0]), ['PUT', '/loanfacts', 15000, '{}']],
  fetchPayCycle: [() => api.fetchPayCycle(), [null, '/paycycle', 15000, undefined]],
  setPayCycle: [() => api.setPayCycle({ length: 14, last_pay_date: '2026-07-01' }), ['PUT', '/paycycle', 15000, '{"length":14,"last_pay_date":"2026-07-01"}']],
  setBudget: [() => api.setBudget('groceries', 100), ['PUT', '/budgets/groceries', 15000, '{"target":100}']],
  deleteBudget: [() => api.deleteBudget('groceries'), ['DELETE', '/budgets/groceries', 15000, undefined]],
  setSpread: [() => api.setSpread('groceries', 100, 3), ['PUT', '/budgets/groceries/spread', 15000, '{"amount":100,"cycles":3}']],
  deleteSpread: [() => api.deleteSpread('groceries'), ['DELETE', '/budgets/groceries/spread', 15000, undefined]],
  listRules: [() => api.listRules(), [null, '/rules', 15000, undefined]],
  createRule: [() => api.createRule({ value: 'COLES', categoryId: 'groceries' }), ['POST', '/rules', 15000, '{"value":"COLES","categoryId":"groceries"}']],
  updateRule: [() => api.updateRule('r1', { value: 'COLES', categoryId: 'groceries' }), ['PUT', '/rules/r1', 15000, '{"value":"COLES","categoryId":"groceries"}']],
  deleteRule: [() => api.deleteRule('r1'), ['DELETE', '/rules/r1', 15000, undefined]],
  fetchAiInsights: [() => api.fetchAiInsights(), [null, '/insights/ai', 15000, undefined]],
  generateAiInsights: [() => api.generateAiInsights(null), ['POST', '/insights/ai', 60000, '{"goal":null}']],
  registerDevice: [() => api.registerDevice('ExpoPushToken[abc]'), ['POST', '/devices', 15000, '{"token":"ExpoPushToken[abc]"}']],
};
const NAMES = Object.keys(WIRE);

describe('[A0] the wire table covers every endpoint', () => {
  it('has a row for every exported function', () => {
    const exported = Object.entries(api)
      .filter(([name, value]) => typeof value === 'function' && name !== 'ApiError')
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual([...NAMES].sort());
  });
});

describe('[A1][A2][A3] each endpoint sends the same method, path, body and time limit', () => {
  it.each(NAMES)('%s', async (name) => {
    const [call, [method, path, timeoutMs, body]] = WIRE[name];
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`${BASE}${path}`);
    // A read sends NO method key at all (not method: 'GET'); only a write carries one.
    expect('method' in init).toBe(method !== null);
    if (method !== null) expect(init.method).toBe(method);
    expect(init.body).toBe(body);
    // Only the keys the old fetches sent — headers, the abort signal, and method/body when present.
    const keys = ['headers', 'signal', ...(method ? ['method'] : []), ...(body !== undefined ? ['body'] : [])];
    expect(Object.keys(init).sort()).toEqual(keys.sort());
    // The same limit bounds the headers AND the success body read.
    expect(timers).toEqual([timeoutMs, timeoutMs]);
  });
});

describe('[A4] a reason-carrying failure reads its error body under the endpoint time limit', () => {
  it.each(NAMES.filter((name) => (api as unknown as Record<string, { errors: string }>)[name].errors === 'withReason'))(
    '%s', async (name) => {
      fetchMock.mockReturnValue(Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'no' }) }));
      const [call, [, , timeoutMs]] = WIRE[name];
      await expect(call()).rejects.toMatchObject({ message: 'API error: 400', serverMessage: 'no' });
      expect(timers).toEqual([timeoutMs, timeoutMs]);
    });
});

describe('[A5] signed out → every endpoint rejects "Not signed in" and never hits the network', () => {
  it.each(NAMES)('%s', async (name) => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(WIRE[name][0]()).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('[A6] a network failure surfaces as a rejection, not a thrown API error', () => {
  it.each(NAMES)('%s', async (name) => {
    fetchMock.mockReturnValue(Promise.reject(new TypeError('Network request failed')));
    await expect(WIRE[name][0]()).rejects.toThrow('Network request failed');
  });
});

describe('[A7] every endpoint returns a promise, even when building its path throws', () => {
  // The old endpoints were `async function`s, so ANY throw — including encodeURIComponent's URIError
  // on a lone surrogate — became a rejected promise. A caller doing `x(...).catch(...)` relies on it.
  const LONE = '\uD800';
  it.each([
    ['getApplyRulesJob', () => api.getApplyRulesJob(LONE)],
    ['getAiChatJob', () => api.getAiChatJob(LONE)],
    ['fetchTransactionsSearch', () => api.fetchTransactionsSearch('all', LONE)],
    ['fetchTransactionsFeed', () => api.fetchTransactionsFeed(LONE)],
    ['updateCategory', () => api.updateCategory(LONE, { name: 'x', bucket: 'Lifestyle', icon: 'x' })],
    ['deleteCategory', () => api.deleteCategory(LONE)],
    ['setTransactionFields', () => api.setTransactionFields(LONE, { notes: 'n' })],
    ['deleteRule', () => api.deleteRule(LONE)],
  ] as const)('%s', async (_name, call) => {
    let result: unknown;
    expect(() => { result = call(); }).not.toThrow();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow(URIError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('[A8] fetchUncategorizedCount still checks the number after the read', () => {
  it.each([[{ count: 'x' }], [{}], [null]])('rejects a malformed body %j', async (body) => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }));
    await expect(api.fetchUncategorizedCount()).rejects.toThrow();
  });

  it('returns the count', async () => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ count: 7 }) }));
    await expect(api.fetchUncategorizedCount()).resolves.toBe(7);
  });
});
