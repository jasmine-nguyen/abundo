// The Transactions tab "Load More" feed — fetchTransactionsFeed URL shaping (src/api.ts). Locks
// the request line the cursor-pagination server contract depends on:
//   [A-feed1] the newest page (no cursor, no limit) OMITS the query string entirely
//   [A-feed2] a cursor APPENDS ?cursor=, percent-encoded so an opaque token can't fork the URL
//   [A-feed3] a limit APPENDS ?limit=n; cursor + limit join with &
//   [A-feed4] a not-OK response throws (no silent empty page to a caller expecting rows)
//   [A-feed5] the { transactions, nextCursor } body round-trips
// fetch is mocked; no network. Mirrors categoryTransactionsApi.gaps.logic.test.ts.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fetchTransactionsFeed } from '../api';

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

describe('fetchTransactionsFeed — URL shaping', () => {
  // [A-feed1] no cursor, no limit -> no query string. FAIL-ON-REVERT: always appending makes
  // this `?cursor=undefined` and the server pages from the wrong place.
  it('omits the query string for the newest page (no cursor, no limit)', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed();
    expect(calledUrl()).toBe(`${API}/transactions/feed`);
  });

  // [A-feed2] a cursor is appended, percent-encoded.
  it('appends ?cursor= for the next page', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed('abc123');
    expect(calledUrl()).toBe(`${API}/transactions/feed?cursor=abc123`);
  });

  it('percent-encodes an opaque cursor so it cannot fork the URL', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed('a/b c&d=e');
    expect(calledUrl()).toBe(`${API}/transactions/feed?cursor=a%2Fb%20c%26d%3De`);
  });

  // [A-feed3] limit appended; cursor + limit join with &.
  it('appends ?limit= when a page size is given', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed(undefined, 50);
    expect(calledUrl()).toBe(`${API}/transactions/feed?limit=50`);
  });

  it('joins cursor and limit with &', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed('cur', 50);
    expect(calledUrl()).toBe(`${API}/transactions/feed?cursor=cur&limit=50`);
  });

  // [A-feed4] a not-OK response throws — the tab must see an error, not an empty page.
  it('throws on a not-OK response', async () => {
    fetchMock.mockReturnValue(notOk(500));
    await expect(fetchTransactionsFeed()).rejects.toThrow('API error: 500');
  });

  it('sends the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed();
    const opts = (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1];
    expect(opts.headers.Authorization).toBe('Bearer test-token');
  });

  // [A-feed5] the page body round-trips unchanged (transactions + the next cursor).
  it('returns the { transactions, nextCursor } page', async () => {
    const page = { transactions: [{ transaction_id: 't1' }], nextCursor: 'next-cur' };
    fetchMock.mockReturnValue(okJson(page));
    await expect(fetchTransactionsFeed()).resolves.toEqual(page);
  });
});
