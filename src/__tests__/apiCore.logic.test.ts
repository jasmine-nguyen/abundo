// Logic tests for the core src/api.ts network layer: URL, method, headers, body
// shape, url-encoding, JSON return, and the not-OK throw for every fetcher. As of
// WHIT-162 every app route is JWT-gated, so each call sends the Cognito ID token
// (Authorization: Bearer <id token>) — these tests assert it on all of them, with
// getAuthToken mocked. fetch is mocked; no network. (WHIT-89, WHIT-110, WHIT-162)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  fetchTransactions, fetchCategories, createCategory, updateCategory, deleteCategory,
  fetchBudgets, fetchBreakdown, setTransactionCategory, setTransactionCategories, fetchPayCycle,
  setPayCycle, setBudget, fetchHomeLoan, fetchLoanFacts, setLoanFacts, fetchRepayment,
} from '../api';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));
import { getAuthToken } from '../auth';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
function notOk(status: number) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  // Every route authenticates with the Cognito ID token (WHIT-162); mock a signed-in
  // session returning a fixed token so the Bearer assertions below hold.
  mockGetAuthToken.mockReset().mockResolvedValue('test-token');
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

function lastCall(): [string, any] {
  return fetchMock.mock.calls[0] as [string, any];
}
function expectAuth(opts: any) {
  // Every gated route must carry the Bearer token (WHIT-110).
  expect(opts.headers.Authorization).toBe('Bearer test-token');
}

describe('reads', () => {
  it('fetchTransactions GETs /transactions with the Bearer token and returns the list', async () => {
    fetchMock.mockReturnValue(okJson([{ transaction_id: 't1' }]));
    const out = await fetchTransactions();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/transactions`);
    expectAuth(opts);
    expect(out).toEqual([{ transaction_id: 't1' }]);
  });

  it('fetchCategories GETs /categories with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson([{ id: 'groceries' }]));
    const out = await fetchCategories();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/categories`);
    expectAuth(opts);
    expect(out).toEqual([{ id: 'groceries' }]);
  });

  it('fetchBudgets GETs /budgets with a url-encoded days param + the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ groceries: { target: 100, posted: 0, pending: 0 } }));
    const out = await fetchBudgets(14);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/budgets?days=14`);
    expectAuth(opts);
    expect(out).toEqual({ groceries: { target: 100, posted: 0, pending: 0 } });
  });

  it('fetchBreakdown GETs /breakdown with a url-encoded days param + the Bearer token', async () => {
    // WHIT-110: /breakdown had no network test at all — the one most likely to ship
    // gated-but-tokenless and 401 the Insights tab. Lock it.
    fetchMock.mockReturnValue(okJson({ coffee: { posted: 20, pending: 5 } }));
    const out = await fetchBreakdown(14);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/breakdown?days=14`);
    expectAuth(opts);
    expect(out).toEqual({ coffee: { posted: 20, pending: 5 } });
  });

  it('fetchPayCycle GETs /paycycle with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ length: 14, last_pay_date: '2026-06-06' }));
    const out = await fetchPayCycle();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/paycycle`);
    expectAuth(opts);
    expect(out).toEqual({ length: 14, last_pay_date: '2026-06-06' });
  });

  it('fetchHomeLoan GETs /homeloan with the Bearer token', async () => {
    const body = { balance: 596642.43, as_of: '2026-07-04T00:24:37.614Z', currency: 'AUD' };
    fetchMock.mockReturnValue(okJson(body));
    const out = await fetchHomeLoan();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/homeloan`);
    expectAuth(opts);
    expect(out).toEqual(body);
  });

  it('fetchLoanFacts GETs /loanfacts with the Bearer token (all-null when unset)', async () => {
    const body = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };
    fetchMock.mockReturnValue(okJson(body));
    const out = await fetchLoanFacts();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/loanfacts`);
    expectAuth(opts);
    expect(out).toEqual(body);
  });

  it('fetchRepayment GETs /repayment with the Bearer token', async () => {
    const body = { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 };
    fetchMock.mockReturnValue(okJson(body));
    const out = await fetchRepayment();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/repayment`);
    expectAuth(opts);
    expect(out).toEqual(body);
  });
});

describe('loan-facts write', () => {
  it('setLoanFacts PUTs /loanfacts with all six fields + the Bearer token', async () => {
    const facts = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };
    fetchMock.mockReturnValue(okJson(facts));
    await setLoanFacts(facts);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/loanfacts`);
    expect(opts.method).toBe('PUT');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual(facts);
  });
});

describe('category writes', () => {
  it('createCategory POSTs /categories with the input body + the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'gym', name: 'Gym' }));
    await createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' });
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/categories`);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' });
  });

  it('updateCategory PATCHes /categories/{id} url-encoded with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b' }));
    await updateCategory('a/b', { name: 'X', bucket: 'Living', icon: 'cart' });
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/categories/a%2Fb`);
    expect(opts.method).toBe('PATCH');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual({ name: 'X', bucket: 'Living', icon: 'cart' });
  });

  it('deleteCategory DELETEs /categories/{id} url-encoded with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b' }));
    await deleteCategory('a/b');
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/categories/a%2Fb`);   // special char proves the encoding
    expect(opts.method).toBe('DELETE');
    expectAuth(opts);
  });
});

describe('transaction + budget + paycycle writes', () => {
  it('setTransactionCategory PATCHes /transactions/{id} with {category} + the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ transaction_id: 't1', category: 'coffee' }));
    await setTransactionCategory('t 1', 'coffee');
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/transactions/t%201`);
    expect(opts.method).toBe('PATCH');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual({ category: 'coffee' });
  });

  it('setTransactionCategories PATCHes /transactions (collection) with {updates} + the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ results: [{ id: 't1', status: 'updated' }] }));
    const out = await setTransactionCategories([{ id: 't1', category: 'coffee' }, { id: 't2', category: 'coffee' }]);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/transactions`);          // collection route, no /{id}
    expect(opts.method).toBe('PATCH');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual({ updates: [{ id: 't1', category: 'coffee' }, { id: 't2', category: 'coffee' }] });
    expect(out).toEqual({ results: [{ id: 't1', status: 'updated' }] });
  });

  it('setPayCycle PUTs /paycycle with the full cycle + the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ length: 30, last_pay_date: '2026-06-01' }));
    await setPayCycle({ length: 30, last_pay_date: '2026-06-01' });
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/paycycle`);
    expect(opts.method).toBe('PUT');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual({ length: 30, last_pay_date: '2026-06-01' });
  });

  it('setBudget PUTs /budgets/{categoryId} url-encoded with {target} + the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b', target: 300 }));
    await setBudget('a/b', 300);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/budgets/a%2Fb`);   // special char proves the encoding
    expect(opts.method).toBe('PUT');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual({ target: 300 });
  });
});

describe('every fetcher throws on a not-OK response', () => {
  const cases: [string, () => Promise<unknown>][] = [
    ['fetchTransactions', () => fetchTransactions()],
    ['fetchCategories', () => fetchCategories()],
    ['fetchBudgets', () => fetchBudgets(14)],
    ['fetchBreakdown', () => fetchBreakdown(14)],
    ['fetchPayCycle', () => fetchPayCycle()],
    ['fetchHomeLoan', () => fetchHomeLoan()],
    ['fetchLoanFacts', () => fetchLoanFacts()],
    ['fetchRepayment', () => fetchRepayment()],
    ['setLoanFacts', () => setLoanFacts({ original: 1, homeValue: 1, lvr: 0.8, ratePct: 5, baseRepay: 1, extra: 0 })],
    ['createCategory', () => createCategory({ name: 'X', bucket: 'Living', icon: 'cart' })],
    ['updateCategory', () => updateCategory('x', { name: 'X', bucket: 'Living', icon: 'cart' })],
    ['deleteCategory', () => deleteCategory('x')],
    ['setTransactionCategory', () => setTransactionCategory('t1', 'c')],
    ['setTransactionCategories', () => setTransactionCategories([{ id: 't1', category: 'c' }])],
    ['setPayCycle', () => setPayCycle({ length: 14, last_pay_date: '2026-06-06' })],
    ['setBudget', () => setBudget('groceries', 100)],
  ];

  it.each(cases)('%s throws API error on 500', async (_name, call) => {
    fetchMock.mockReturnValue(notOk(500));
    await expect(call()).rejects.toThrow('API error: 500');
  });
});

describe('auth token required', () => {
  it('a read throws (and never calls fetch) when there is no Cognito session', async () => {
    // With the static secret retired (WHIT-162), a call with no session fails loudly
    // rather than sending an empty Bearer.
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(fetchTransactions()).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
