// WHIT-275 — GAP: the REAL src/api.ts network wrapper setTransactionFields. The provider
// tests mock ../api entirely, so the wire behaviour is otherwise untested: id is
// url-encoded, method is PATCH, the Bearer token rides along, the body carries ONLY the
// provided keys (editing the note never sends tags), and a non-OK response throws. Mirrors
// the apiCore.logic.test.ts pattern (fetch + ../auth mocked; no network).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { setTransactionFields } from '../api';

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

describe('setTransactionFields (WHIT-275)', () => {
  it('PATCHes /transactions/{id} (url-encoded) with only the note field + the Bearer token', async () => { // [A22]
    fetchMock.mockReturnValue(okJson({ transaction_id: 't 1', notes: 'lunch' }));
    await setTransactionFields('t 1', { notes: 'lunch' });
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/transactions/t%201`);        // id url-encoded
    expect(opts.method).toBe('PATCH');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(opts.body)).toEqual({ notes: 'lunch' }); // ONLY the changed field
  });

  it('sends a [] tags body verbatim when clearing (never omitted)', async () => { // [A23]
    fetchMock.mockReturnValue(okJson({ transaction_id: 't1' }));
    await setTransactionFields('t1', { tags: [] });
    const [, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(JSON.parse(opts.body)).toEqual({ tags: [] }); // empty list must reach the server (clear)
  });

  it('throws on a non-OK response (e.g. 404 unknown id)', async () => { // [A24]
    fetchMock.mockReturnValue(notOk(404));
    await expect(setTransactionFields('t1', { notes: 'x' })).rejects.toThrow('API error: 404');
  });

  // WHIT-296: the budget-exclude override travels on the same PATCH body.
  it('sends the budget_excluded override verbatim (true and false both reach the server)', async () => {
    fetchMock.mockReturnValue(okJson({ transaction_id: 't1', budget_excluded: true }));
    await setTransactionFields('t1', { budget_excluded: true });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body)).toEqual({ budget_excluded: true });

    fetchMock.mockReturnValue(okJson({ transaction_id: 't1' }));
    await setTransactionFields('t1', { budget_excluded: false }); // false clears — must not be omitted
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, any])[1].body)).toEqual({ budget_excluded: false });
  });
});
