// WHIT-160 — the BARE-HEADER DELETE call sites (deleteCategory / deleteEnrichment)
// must also flow through buildHeaders so they carry the Cognito ID token under the
// flag and the static secret with it off. authHeaders.logic.test.ts only proves the
// GET (fetchTransactions) and the two spread POST sites; these two DELETEs — which
// pass NO extra headers — are the untested bare sites.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));

import { getAuthToken } from '../auth';
import { deleteCategory, deleteEnrichment } from '../api';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
let fetchMock: jest.Mock;

const okJson = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const lastHeaders = (): Record<string, string> =>
  (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_TOKEN = 'static-secret';
  mockGetAuthToken.mockReset();
  fetchMock = jest.fn().mockReturnValue(okJson({ id: 'x' }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_TOKEN;
  delete process.env.EXPO_PUBLIC_AUTH_USE_COGNITO;
});

describe('deleteCategory (bare-header DELETE)', () => {
  it('flag off -> static secret', async () => {
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await deleteCategory('c1');
    expect(lastHeaders().Authorization).toBe('Bearer static-secret');
  });
  it('flag on + session -> Cognito ID token', async () => {
    process.env.EXPO_PUBLIC_AUTH_USE_COGNITO = 'true';
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await deleteCategory('c1');
    expect(lastHeaders().Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });
});

describe('deleteEnrichment (bare-header DELETE)', () => {
  it('flag on + session -> Cognito ID token', async () => {
    process.env.EXPO_PUBLIC_AUTH_USE_COGNITO = 'true';
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await deleteEnrichment('e1');
    expect(lastHeaders().Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });
  it('flag on + NO session -> static-secret fallback (never sends an empty Bearer)', async () => {
    process.env.EXPO_PUBLIC_AUTH_USE_COGNITO = 'true';
    mockGetAuthToken.mockResolvedValue(undefined);
    await deleteEnrichment('e1');
    expect(lastHeaders().Authorization).toBe('Bearer static-secret');
  });
});
