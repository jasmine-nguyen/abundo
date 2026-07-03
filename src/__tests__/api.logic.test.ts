// Logic test: the enrichments api-client functions. Verifies the Authorization
// header (Bearer + EXPO_PUBLIC_API_TOKEN), the request body/method/url shape
// (incl. encodeURIComponent + server-default field/operator omission), and the
// not-OK throw. fetch is mocked; no network. WHIT-52 Slice 2.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { listEnrichments, createEnrichment, deleteEnrichment } from '../api';

const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
function notOk(status: number) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_TOKEN = 'test-token';
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_TOKEN;
});

const RULE = { id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' };

describe('listEnrichments', () => {
  it('GETs /enrichments with the Bearer token and returns the rules', async () => {
    fetchMock.mockReturnValue(okJson([RULE]));
    const out = await listEnrichments();
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/enrichments`);
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(out).toEqual([RULE]);
  });
});

describe('createEnrichment', () => {
  it('POSTs value+categoryId only (server applies field/operator defaults)', async () => {
    fetchMock.mockReturnValue(okJson(RULE));
    await createEnrichment({ value: 'NETFLIX', categoryId: 'subs' });
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/enrichments`);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(opts.body)).toEqual({ value: 'NETFLIX', categoryId: 'subs' });
  });

  it('passes field/operator through when supplied', async () => {
    fetchMock.mockReturnValue(okJson(RULE));
    await createEnrichment({ value: 'FOOD_AND_DRINK', categoryId: 'eatingout', field: 'category', operator: 'equals' });
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(opts.body)).toEqual({ value: 'FOOD_AND_DRINK', categoryId: 'eatingout', field: 'category', operator: 'equals' });
  });
});

describe('deleteEnrichment', () => {
  it('DELETEs /enrichments/{id} url-encoded, with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b' }));
    await deleteEnrichment('a/b');
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/enrichments/a%2Fb`);
    expect(opts.method).toBe('DELETE');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
  });
});

describe('auth + error handling', () => {
  it('throws (never calls fetch) when the token is missing', async () => {
    delete process.env.EXPO_PUBLIC_API_TOKEN;
    await expect(listEnrichments()).rejects.toThrow('Missing EXPO_PUBLIC_API_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a not-OK response', async () => {
    fetchMock.mockReturnValue(notOk(401));
    await expect(createEnrichment({ value: 'X', categoryId: 'c' })).rejects.toThrow('API error: 401');
  });
});
