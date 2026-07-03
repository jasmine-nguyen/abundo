// Logic tests for the core (non-enrichment) src/api.ts network layer: URL,
// method, headers, body shape, url-encoding, JSON return, and the not-OK throw
// for every fetcher. These endpoints are UNAUTHENTICATED (only /enrichments sends
// a Bearer token — see api.logic.test.ts), so each test also confirms no
// Authorization header leaks onto them. fetch is mocked; no network. (WHIT-89)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  fetchTransactions, fetchCategories, createCategory, updateCategory, deleteCategory,
  fetchBudgets, setTransactionCategory, fetchPayCycle, setPayCycle, setBudget,
} from '../api';

const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
function notOk(status: number) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  // Deliberately DON'T set EXPO_PUBLIC_API_TOKEN: these calls must not touch auth,
  // so if one wrongly called authHeaders() it would throw and fail the test.
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

function lastCall(): [string, any] {
  return fetchMock.mock.calls[0] as [string, any];
}
function noAuth(opts: any) {
  // GET calls pass no options/headers; write calls pass only Content-Type.
  const headers = (opts && opts.headers) || {};
  expect(headers.Authorization).toBeUndefined();
}

describe('reads', () => {
  it('fetchTransactions GETs /transactions and returns the list', async () => {
    fetchMock.mockReturnValue(okJson([{ transaction_id: 't1' }]));
    const out = await fetchTransactions();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/transactions`);
    expect(opts).toBeUndefined();            // plain GET, no options object
    expect(out).toEqual([{ transaction_id: 't1' }]);
  });

  it('fetchCategories GETs /categories', async () => {
    fetchMock.mockReturnValue(okJson([{ id: 'groceries' }]));
    const out = await fetchCategories();
    expect(lastCall()[0]).toBe(`${API}/categories`);
    expect(out).toEqual([{ id: 'groceries' }]);
  });

  it('fetchBudgets GETs /budgets with a url-encoded days param', async () => {
    fetchMock.mockReturnValue(okJson({ groceries: { target: 100, posted: 0, pending: 0 } }));
    const out = await fetchBudgets(14);
    expect(lastCall()[0]).toBe(`${API}/budgets?days=14`);
    expect(out).toEqual({ groceries: { target: 100, posted: 0, pending: 0 } });
  });

  it('fetchPayCycle GETs /paycycle', async () => {
    fetchMock.mockReturnValue(okJson({ length: 14, last_pay_date: '2026-06-06' }));
    const out = await fetchPayCycle();
    expect(lastCall()[0]).toBe(`${API}/paycycle`);
    expect(out).toEqual({ length: 14, last_pay_date: '2026-06-06' });
  });
});

describe('category writes', () => {
  it('createCategory POSTs /categories with the input body', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'gym', name: 'Gym' }));
    await createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' });
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/categories`);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    noAuth(opts);
    expect(JSON.parse(opts.body)).toEqual({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' });
  });

  it('updateCategory PATCHes /categories/{id} url-encoded', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b' }));
    await updateCategory('a/b', { name: 'X', bucket: 'Living', icon: 'cart' });
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/categories/a%2Fb`);
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ name: 'X', bucket: 'Living', icon: 'cart' });
  });

  it('deleteCategory DELETEs /categories/{id} url-encoded', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b' }));
    await deleteCategory('a/b');
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/categories/a%2Fb`);   // special char proves the encoding
    expect(opts.method).toBe('DELETE');
    noAuth(opts);
  });
});

describe('transaction + budget + paycycle writes', () => {
  it('setTransactionCategory PATCHes /transactions/{id} with {category}', async () => {
    fetchMock.mockReturnValue(okJson({ transaction_id: 't1', category: 'coffee' }));
    await setTransactionCategory('t 1', 'coffee');
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/transactions/t%201`);
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ category: 'coffee' });
  });

  it('setPayCycle PUTs /paycycle with the full cycle', async () => {
    fetchMock.mockReturnValue(okJson({ length: 30, last_pay_date: '2026-06-01' }));
    await setPayCycle({ length: 30, last_pay_date: '2026-06-01' });
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/paycycle`);
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ length: 30, last_pay_date: '2026-06-01' });
  });

  it('setBudget PUTs /budgets/{categoryId} url-encoded with {target}', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b', target: 300 }));
    await setBudget('a/b', 300);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/budgets/a%2Fb`);   // special char proves the encoding
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ target: 300 });
  });
});

describe('every fetcher throws on a not-OK response', () => {
  const cases: [string, () => Promise<unknown>][] = [
    ['fetchTransactions', () => fetchTransactions()],
    ['fetchCategories', () => fetchCategories()],
    ['fetchBudgets', () => fetchBudgets(14)],
    ['fetchPayCycle', () => fetchPayCycle()],
    ['createCategory', () => createCategory({ name: 'X', bucket: 'Living', icon: 'cart' })],
    ['updateCategory', () => updateCategory('x', { name: 'X', bucket: 'Living', icon: 'cart' })],
    ['deleteCategory', () => deleteCategory('x')],
    ['setTransactionCategory', () => setTransactionCategory('t1', 'c')],
    ['setPayCycle', () => setPayCycle({ length: 14, last_pay_date: '2026-06-06' })],
    ['setBudget', () => setBudget('groceries', 100)],
  ];

  it.each(cases)('%s throws API error on 500', async (_name, call) => {
    fetchMock.mockReturnValue(notOk(500));
    await expect(call()).rejects.toThrow('API error: 500');
  });
});
