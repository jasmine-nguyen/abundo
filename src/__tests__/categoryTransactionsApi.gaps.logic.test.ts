// WHIT-342 GAP — fetchCategoryTransactions URL shaping (src/api.ts). The endpoint call is
// otherwise only exercised transitively; this locks the request line the server contract
// depends on:
//   [A-api1] cycle 0 (default) OMITS ?cycle= — the minimal request the server treats as "current"
//   [A-api2] cycle > 0 APPENDS ?cycle=n
//   [A-api3] the __uncategorized__ sentinel + a slash-bearing id round-trip through
//            encodeURIComponent (so a '/' in the id never forks the path)
//   [A-api4] a not-OK response throws (no silent empty list to a caller expecting rows)
// fetch is mocked; no network. Mirrors api.logic.test.ts.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fetchCategoryTransactions } from '../api';

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
  mockGetAuthToken.mockReset().mockResolvedValue('test-token');
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

function calledUrl(): string {
  return (fetchMock.mock.calls[0] as [string, unknown])[0];
}

describe('fetchCategoryTransactions — URL shaping', () => {
  // [A-api1] cycle 0 -> no query string at all. FAIL-ON-REVERT: dropping the `cycle > 0` guard
  // (always appending) makes this `?cycle=0`.
  it('omits ?cycle= for the current cycle (0)', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('coffee', 0);
    expect(calledUrl()).toBe(`${API}/categories/coffee/transactions`);
  });

  it('omits ?cycle= when cycle defaults (not passed)', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('coffee');
    expect(calledUrl()).toBe(`${API}/categories/coffee/transactions`);
  });

  // [A-api2] cycle > 0 -> appended. FAIL-ON-REVERT: dropping the append sends the current window
  // for a "last cycle" drill (the exact bug WHIT-342 fixes).
  it('appends ?cycle=n for a prior cycle', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('coffee', 1);
    expect(calledUrl()).toBe(`${API}/categories/coffee/transactions?cycle=1`);
  });

  // [A-api3] the sentinel + a slash-bearing id are percent-encoded so the path can't fork.
  // FAIL-ON-REVERT: dropping encodeURIComponent lets the raw '__uncategorized__' (fine) but a
  // '/' id (e.g. 'food/drink') would inject a path segment — asserted via the encoded form.
  it('encodes the __uncategorized__ sentinel into the path', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('__uncategorized__', 0);
    expect(calledUrl()).toBe(`${API}/categories/__uncategorized__/transactions`);
  });

  it('percent-encodes a slash-bearing id so it cannot fork the path', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('food/drink', 2);
    expect(calledUrl()).toBe(`${API}/categories/food%2Fdrink/transactions?cycle=2`);
  });

  // [A-api4] a not-OK response throws — the drill screen must see an error, not an empty list.
  // FAIL-ON-REVERT: removing the `response.ok == false` guard returns undefined/[] silently.
  it('throws on a not-OK response', async () => {
    fetchMock.mockReturnValue(notOk(500));
    await expect(fetchCategoryTransactions('coffee', 0)).rejects.toThrow('API error: 500');
  });

  it('sends the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('coffee', 0);
    const opts = (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1];
    expect(opts.headers.Authorization).toBe('Bearer test-token');
  });
});
