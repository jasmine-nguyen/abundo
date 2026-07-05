// WHIT-160/162 — the BARE-HEADER DELETE call sites (deleteCategory / deleteEnrichment)
// must also flow through buildHeaders so they carry the Cognito ID token and throw
// (never send an empty Bearer) when there's no session. authHeaders.logic.test.ts
// proves the GET + the two spread POST sites; these two DELETEs pass NO extra
// headers, so they're the separately-worth-locking bare sites.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));

import { getAuthToken } from '../auth';
import { deleteCategory, deleteEnrichment } from '../api';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
let fetchMock: jest.Mock;

const okJson = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const lastHeaders = (): Record<string, string> =>
  (fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers;

beforeEach(() => {
  mockGetAuthToken.mockReset();
  fetchMock = jest.fn().mockReturnValue(okJson({ id: 'x' }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('deleteCategory (bare-header DELETE)', () => {
  it('carries the Cognito ID token', async () => {
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await deleteCategory('c1');
    expect(lastHeaders().Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });
  it('throws "Not signed in" with no session (never sends an empty Bearer)', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(deleteCategory('c1')).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('deleteEnrichment (bare-header DELETE)', () => {
  it('carries the Cognito ID token', async () => {
    mockGetAuthToken.mockResolvedValue('COGNITO_ID_TOKEN');
    await deleteEnrichment('e1');
    expect(lastHeaders().Authorization).toBe('Bearer COGNITO_ID_TOKEN');
  });
  it('throws "Not signed in" with no session', async () => {
    mockGetAuthToken.mockResolvedValue(undefined);
    await expect(deleteEnrichment('e1')).rejects.toThrow('Not signed in');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
