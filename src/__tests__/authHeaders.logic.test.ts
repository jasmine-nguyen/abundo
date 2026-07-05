// WHIT-160 — the ROLLOUT-SAFETY tests for src/api.ts's header logic. The Cognito
// cutover ships DARK: even with a live session, the API must keep receiving the
// static secret until EXPO_PUBLIC_AUTH_USE_COGNITO is explicitly 'true' (the JWT
// authorizer is attached to no route until WHIT-162, so a Cognito token would
// 403). Also guards the async-header refactor: spread call sites must still send
// BOTH Authorization and Content-Type (a spread of a Promise would drop the auth
// header). '../auth' is mocked so getAuthToken is controllable; fetch is mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../auth', () => ({
  getAuthToken: jest.fn<() => Promise<string | undefined>>(),
}));

import { getAuthToken } from '../auth';
import { fetchTransactions, createCategory, generateAiInsights } from '../api';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
let fetchMock: jest.Mock;

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
function lastHeaders(): Record<string, string> {
  return (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_TOKEN = 'static-secret';
  mockGetAuthToken.mockReset();
  fetchMock = jest.fn().mockReturnValue(okJson([]));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_TOKEN;
  delete process.env.EXPO_PUBLIC_AUTH_USE_COGNITO;
});

describe('dark by default (flag off)', () => {
  it('sends the static secret when there is no Cognito session', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await fetchTransactions();
    expect(lastHeaders().Authorization).toBe('Bearer static-secret');
  });

  it('STILL sends the static secret even when a Cognito session exists (rollout safety)', async () => {
    // A live session must NOT change what the API receives while the flag is off —
    // this is the guard against 403-ing every request before WHIT-162.
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await fetchTransactions();
    expect(lastHeaders().Authorization).toBe('Bearer static-secret');
  });
});

describe('flag on (EXPO_PUBLIC_AUTH_USE_COGNITO=true)', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_AUTH_USE_COGNITO = 'true';
  });

  it('sends the Cognito ID token when a session is present', async () => {
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await fetchTransactions();
    expect(lastHeaders().Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });

  it('falls back to the static secret when there is no session yet', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await fetchTransactions();
    expect(lastHeaders().Authorization).toBe('Bearer static-secret');
  });
});

describe('spread call sites keep BOTH headers (Promise-spread guard)', () => {
  it('createCategory (Content-Type first) sends Authorization AND Content-Type', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await createCategory({ name: 'X', bucket: 'needs' as never, icon: 'i' });
    const headers = lastHeaders();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer static-secret');
  });

  it('generateAiInsights (auth spread first) sends Authorization AND Content-Type', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await generateAiInsights();
    const headers = lastHeaders();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer static-secret');
  });
});
