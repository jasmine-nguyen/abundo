// WHIT-233 — the goal id url-encoding in src/api.ts (saveGoal / deleteGoal). The goals wire,
// Bearer token and not-OK throw are covered by the shared API contract tests. fetch +
// getAuthToken mocked; no network.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { saveGoal, deleteGoal } from '../api';
import type { GoalWriteBody } from '../api';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule());
import { getAuthToken } from '../auth';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
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

describe('saveGoal', () => {
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
