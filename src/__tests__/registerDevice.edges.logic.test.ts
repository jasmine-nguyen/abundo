// Adversarial gaps for registerDevice (Client: notification permission +
// device-token registration). The implementer's api.logic.test.ts already locks
// the happy POST, the not-OK throw, and the missing-secret throw. This file adds
// the parity gap: a 200 whose body is NOT valid JSON must propagate (like every
// other fetcher's `return response.json()`), so push.ts's outer try/catch is the
// thing that swallows it — the api layer itself never hides it. fetch is mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { registerDevice } from '../api';

// WHIT-162: registerDevice authenticates with the Cognito ID token; mock a session.
jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('registerDevice — edge/error parity', () => {
  it('propagates a JSON-parse failure on a 200 (no swallowing at the api layer)', async () => {
    // Server said 200 but sent a non-JSON body (e.g. an HTML error page from a proxy).
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')) }),
    );
    await expect(registerDevice('ExpoPushToken[x]')).rejects.toThrow(SyntaxError);
  });

  it('throws on a 401 (auth rejected) without reading the body', async () => {
    // Distinct from the implementer's 400 case: confirms the not-OK branch fires for
    // the auth failure the /devices authorizer would actually return.
    const json = jest.fn(() => Promise.resolve({}));
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, status: 401, json }));
    await expect(registerDevice('ExpoPushToken[x]')).rejects.toThrow('API error: 401');
    expect(json).not.toHaveBeenCalled();
  });

  it('sends an unencoded token verbatim in the JSON body (not the URL)', async () => {
    // Tokens carry [] and can carry other chars; they live in the body, so no
    // encodeURIComponent is expected — the exact string must survive round-trip.
    const weird = 'ExpoPushToken[a b/+=]';
    fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ token: weird }) }));
    await registerDevice(weird);
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/devices`);
    expect(JSON.parse(opts.body)).toEqual({ token: weird });
  });
});
