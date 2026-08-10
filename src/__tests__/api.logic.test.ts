// Logic test: the enrichments api-client functions. Verifies the Authorization
// header (Bearer + Cognito ID token, getAuthToken mocked), the request
// body/method/url shape (incl. encodeURIComponent + server-default field/operator
// omission), and the not-OK throw. fetch is mocked; no network. (WHIT-52, WHIT-162)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { listEnrichments, createEnrichment, updateEnrichment, deleteEnrichment, fetchAiInsights, generateAiInsights, registerDevice, fetchCategoryTransactions, fetchTransactionsFeed } from '../api';

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
  // WHIT-162: authenticate with the Cognito ID token; mock a signed-in session.
  mockGetAuthToken.mockReset().mockResolvedValue('test-token');
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
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

describe('AI insights (WHIT-104)', () => {
  const AI = { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false };

  it('fetchAiInsights GETs /insights/ai with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ ...AI, summary: null, suggestions: [], cached: false }));
    const out = await fetchAiInsights();
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/insights/ai`);
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(out.cached).toBe(false);
  });

  it('generateAiInsights POSTs /insights/ai with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson(AI));
    const out = await generateAiInsights();
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/insights/ai`);
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    // No goal -> body carries {goal: null}, JSON content-type.
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ goal: null });
    expect(out).toEqual(AI);
  });

  it('generateAiInsights sends the home-loan goal in the body when supplied (WHIT-134)', async () => {
    fetchMock.mockReturnValue(okJson(AI));
    const goal = { payoff_mode: 'ahead' as const, mortgage_free_date: 'Nov 2042', current_extra_monthly: 500, months_sooner_per_100_extra: 7 };
    await generateAiInsights(goal);
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(opts.body)).toEqual({ goal });
  });

  it('fetchAiInsights throws on a not-OK response', async () => {
    fetchMock.mockReturnValue(notOk(401));
    await expect(fetchAiInsights()).rejects.toThrow('API error: 401');
  });

  it('generateAiInsights throws on a 502 (AI unavailable)', async () => {
    fetchMock.mockReturnValue(notOk(502));
    await expect(generateAiInsights()).rejects.toThrow('API error: 502');
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

describe('updateEnrichment', () => {
  it('PUTs /enrichments/{id} url-encoded, with body + Bearer token', async () => {
    fetchMock.mockReturnValue(okJson(RULE));
    await updateEnrichment('a/b', { value: 'NETFLIX', categoryId: 'subs' });
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/enrichments/a%2Fb`);
    expect(opts.method).toBe('PUT');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(opts.body)).toEqual({ value: 'NETFLIX', categoryId: 'subs' });
  });

  it('passes field/operator through when supplied', async () => {
    fetchMock.mockReturnValue(okJson(RULE));
    await updateEnrichment('e1', { value: 'X', categoryId: 'c', field: 'category', operator: 'equals' });
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(opts.body)).toEqual({ value: 'X', categoryId: 'c', field: 'category', operator: 'equals' });
  });

  it('throws on a not-OK response (e.g. 404 unknown id)', async () => {
    fetchMock.mockReturnValue(notOk(404));
    await expect(updateEnrichment('gone', { value: 'X', categoryId: 'c' })).rejects.toThrow('API error: 404');
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

describe('registerDevice', () => {
  it('POSTs /devices with the Bearer token and the {token} body', async () => {
    fetchMock.mockReturnValue(okJson({ token: 'ExpoPushToken[x]' }));
    const out = await registerDevice('ExpoPushToken[x]');
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/devices`);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(opts.body)).toEqual({ token: 'ExpoPushToken[x]' });
    expect(out).toEqual({ token: 'ExpoPushToken[x]' });
  });

  it('throws on a not-OK response', async () => {
    fetchMock.mockReturnValue(notOk(400));
    await expect(registerDevice('ExpoPushToken[x]')).rejects.toThrow('API error: 400');
  });

  it('throws (never calls fetch) when there is no Cognito session', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(registerDevice('ExpoPushToken[x]')).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('auth + error handling', () => {
  it('throws (never calls fetch) when there is no Cognito session', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(listEnrichments()).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a not-OK response', async () => {
    fetchMock.mockReturnValue(notOk(401));
    await expect(createEnrichment({ value: 'X', categoryId: 'c' })).rejects.toThrow('API error: 401');
  });
});

// ===== WHIT-342 fetchCategoryTransactions URL shaping (folded from categoryTransactionsApi.gaps.logic.test.ts)
// gaps-only helper (survivor already has okJson/notOk/API/preamble/beforeEach)
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

// ===== fetchTransactionsFeed URL shaping (folded from transactionsFeedApi.gaps.logic.test.ts)
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
