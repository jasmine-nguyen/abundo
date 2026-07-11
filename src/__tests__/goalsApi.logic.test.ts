// WHIT-233 — logic tests for the goal network layer in src/api.ts: URL, method, headers,
// body shape, url-encoding, JSON return, and the not-OK throw for fetchGoals/saveGoal/
// deleteGoal. Every /goals route is JWT-gated like the rest of the API, so each call must
// send the Cognito ID token (Authorization: Bearer <id token>). fetch + getAuthToken mocked;
// no network. Mirrors apiCore.logic.test.ts.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fetchGoals, saveGoal, deleteGoal } from '../api';
import type { GoalWriteBody } from '../api';

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

function lastCall(): [string, any] {
  return fetchMock.mock.calls[0] as [string, any];
}
function expectAuth(opts: any) {
  expect(opts.headers.Authorization).toBe('Bearer test-token');
}

const SYNCED_BODY: GoalWriteBody = {
  name: 'Emergency fund', icon: 'umbrella', direction: 'grow',
  target_amount: 10000, target_date: '2026-12-01', account_id: 'up-spending',
};
const MANUAL_BODY: GoalWriteBody = {
  name: 'Car loan', icon: 'car', direction: 'paydown',
  target_amount: 0, target_date: '2027-06-01', manual_balance: 8400, manual_as_of: '2026-07-01',
};

describe('fetchGoals', () => {
  it('GETs /goals with the Bearer token and returns the list', async () => {
    fetchMock.mockReturnValue(okJson([{ id: 'g1', name: 'Emergency fund' }]));
    const out = await fetchGoals();
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/goals`);
    expect(opts.method).toBeUndefined(); // a plain GET
    expectAuth(opts);
    expect(out).toEqual([{ id: 'g1', name: 'Emergency fund' }]);
  });

  it('returns an empty array unchanged (the "no goals yet" success)', async () => {
    fetchMock.mockReturnValue(okJson([]));
    expect(await fetchGoals()).toEqual([]);
  });
});

describe('saveGoal', () => {
  it('PUTs /goals/{id} with the synced body + the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'g1', ...SYNCED_BODY }));
    const out = await saveGoal('g1', SYNCED_BODY);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/goals/g1`);
    expect(opts.method).toBe('PUT');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expectAuth(opts);
    expect(JSON.parse(opts.body)).toEqual(SYNCED_BODY);
    expect(out).toEqual({ id: 'g1', ...SYNCED_BODY });
  });

  it('sends the manual body verbatim (both manual fields, no account_id)', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'car1', ...MANUAL_BODY }));
    await saveGoal('car1', MANUAL_BODY);
    const [, opts] = lastCall();
    expect(JSON.parse(opts.body)).toEqual(MANUAL_BODY);
    expect(JSON.parse(opts.body).account_id).toBeUndefined();
  });

  it('url-encodes the id in the path (never in the body)', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b' }));
    await saveGoal('a/b', SYNCED_BODY);
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/goals/a%2Fb`); // special char proves the encoding
    expect(JSON.parse(opts.body).id).toBeUndefined(); // id lives in the path only
  });
});

describe('deleteGoal', () => {
  it('DELETEs /goals/{id} url-encoded with the Bearer token', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'a/b' }));
    const out = await deleteGoal('a/b');
    const [url, opts] = lastCall();
    expect(url).toBe(`${API}/goals/a%2Fb`);
    expect(opts.method).toBe('DELETE');
    expectAuth(opts);
    expect(out).toEqual({ id: 'a/b' });
  });
});

describe('every goal call throws on a not-OK response', () => {
  const cases: [string, () => Promise<unknown>][] = [
    ['fetchGoals', () => fetchGoals()],
    ['saveGoal', () => saveGoal('g1', SYNCED_BODY)],
    ['deleteGoal', () => deleteGoal('g1')],
  ];

  it.each(cases)('%s throws API error on 500', async (_name, call) => {
    fetchMock.mockReturnValue(notOk(500));
    await expect(call()).rejects.toThrow('API error: 500');
  });
});
