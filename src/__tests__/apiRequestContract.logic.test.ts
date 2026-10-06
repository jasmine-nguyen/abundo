// WHIT-631 QA — the one shared request step must keep every endpoint's wire contract. These pin, per
// endpoint, the method / path / time limit / body the old hand-written fetches sent, so a change to
// `request()` or to one endpoint's declaration can't quietly move them.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule());

import { getAuthToken } from '../auth';
import * as api from '../api';
import { WIRE } from './support/apiWire';

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
