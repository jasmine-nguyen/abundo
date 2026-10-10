// Logic test: api-client request shaping. Verifies the Authorization header
// (Bearer + Cognito ID token, getAuthToken mocked), request bodies, and URL
// shaping (encodeURIComponent, optional query strings). fetch is mocked; no network.
// (WHIT-52, WHIT-162)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { listRules, createRule, generateAiInsights, fetchCategoryTransactions, fetchTransactionsFeed, setBudget } from '../api';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule());
import { getAuthToken } from '../auth';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  // WHIT-162: authenticate with the Cognito ID token; mock a signed-in session.
  mockGetAuthToken.mockReset().mockResolvedValue('test-token');
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

const RULE = { id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' };

function calledUrl(): string {
  return (fetchMock.mock.calls[0] as [string, unknown])[0];
}

describe('listRules', () => {
  it('GETs /rules with the Bearer token and returns the rules', async () => {
    fetchMock.mockReturnValue(okJson([RULE]));
    const out = await listRules();
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/rules`);
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(out).toEqual([RULE]);
  });
});

describe('AI insights (WHIT-104)', () => {
  const AI = { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false };

  it('generateAiInsights sends the home-loan goal in the body when supplied (WHIT-134)', async () => {
    fetchMock.mockReturnValue(okJson(AI));
    const goal = { payoff_mode: 'ahead' as const, mortgage_free_date: 'Nov 2042', current_extra_monthly: 500, months_sooner_per_100_extra: 7 };
    await generateAiInsights(goal);
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(opts.body)).toEqual({ goal });
  });
});

describe('createRule', () => {
  it('passes field/operator through when supplied', async () => {
    fetchMock.mockReturnValue(okJson(RULE));
    await createRule({ value: 'FOOD_AND_DRINK', categoryId: 'eatingout', field: 'category', operator: 'equals' });
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(opts.body)).toEqual({ value: 'FOOD_AND_DRINK', categoryId: 'eatingout', field: 'category', operator: 'equals' });
  });
});

describe('auth + error handling', () => {
  it('throws (never calls fetch) when there is no Cognito session', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(listRules()).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// WHIT-459: an absent rollover flag means "no change", so it must not be sent.
describe('setBudget — rollover in the request body', () => {
  it.each([
    ['OMITS rollover when the caller does not pass it (leave the stored flag untouched)', undefined, { target: 58 }],
    ['INCLUDES rollover: true when passed true', true, { target: 58, rollover: true }],
    ['INCLUDES rollover: false when passed false (an explicit turn-off, not an omission)', false, { target: 58, rollover: false }],
  ])('%s', async (_title, rollover, expected) => {
    fetchMock.mockReturnValue(okJson({ id: 'coffee', target: 58 }));
    await setBudget('coffee', 58, rollover);
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/budgets/coffee`);
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toStrictEqual(expected);
  });
});

describe('fetchCategoryTransactions — URL shaping', () => {
  // FAIL-ON-REVERT: dropping the `cycle > 0` guard (always appending) makes this `?cycle=0`.
  it('omits ?cycle= for the current cycle (0)', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('coffee', 0);
    expect(calledUrl()).toBe(`${API}/categories/coffee/transactions`);
  });

  // FAIL-ON-REVERT: dropping the append sends the current window for a "last cycle" drill (WHIT-342).
  it('appends ?cycle=n for a prior cycle', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('coffee', 1);
    expect(calledUrl()).toBe(`${API}/categories/coffee/transactions?cycle=1`);
  });

  it('percent-encodes a slash-bearing id so it cannot fork the path', async () => {
    fetchMock.mockReturnValue(okJson([]));
    await fetchCategoryTransactions('food/drink', 2);
    expect(calledUrl()).toBe(`${API}/categories/food%2Fdrink/transactions?cycle=2`);
  });
});

describe('fetchTransactionsFeed — URL shaping', () => {
  // FAIL-ON-REVERT: always appending makes this `?cursor=undefined` and the server pages from the wrong place.
  it('omits the query string for the newest page (no cursor, no limit)', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed();
    expect(calledUrl()).toBe(`${API}/transactions/feed`);
  });

  it('percent-encodes an opaque cursor so it cannot fork the URL', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed('a/b c&d=e');
    expect(calledUrl()).toBe(`${API}/transactions/feed?cursor=a%2Fb%20c%26d%3De`);
  });

  it('joins cursor and limit with &', async () => {
    fetchMock.mockReturnValue(okJson({ transactions: [], nextCursor: null }));
    await fetchTransactionsFeed('cur', 50);
    expect(calledUrl()).toBe(`${API}/transactions/feed?cursor=cur&limit=50`);
  });
});
