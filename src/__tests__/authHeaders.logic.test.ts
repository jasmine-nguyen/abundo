// WHIT-162 — src/api.ts header logic, now Cognito-only (the static secret is
// retired). authHeaders sends the Cognito ID token; it throws "Not signed in" when
// there is no session (no static fallback). Also guards the async-header refactor:
// spread call sites must still send BOTH Authorization and Content-Type (a spread
// of a Promise would drop the auth header). '../auth' is mocked so getAuthToken is
// controllable; fetch is mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

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
  mockGetAuthToken.mockReset();
  fetchMock = jest.fn().mockReturnValue(okJson([]));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('Cognito-only auth header', () => {
  it('sends the Cognito ID token when a session is present', async () => {
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await fetchTransactions();
    expect(lastHeaders().Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });

  it('throws "Not signed in" (no static fallback) when there is no session', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(fetchTransactions()).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('spread call sites keep BOTH headers (Promise-spread guard)', () => {
  it('createCategory (Content-Type first) sends Authorization AND Content-Type', async () => {
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await createCategory({ name: 'X', bucket: 'needs' as never, icon: 'i' });
    const headers = lastHeaders();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });

  it('generateAiInsights (auth spread first) sends Authorization AND Content-Type', async () => {
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await generateAiInsights();
    const headers = lastHeaders();
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });
});
