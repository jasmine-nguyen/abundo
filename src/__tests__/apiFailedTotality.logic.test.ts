// WHIT-437 — the three category writes carry the server's reason, and the reader that extracts it
// can NEVER itself throw.
//
// That totality is the load-bearing half. A gateway 403 or 502 answers with an HTML page, and an
// unguarded response.json() would reject with a SyntaxError carrying no status — which both
// violates the `API error: N` contract ~99 assertions pin AND defeats src/queryClient.ts's auth
// detection, silently retrying a dead session.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));

import { getAuthToken } from '../auth';
import { createCategory, updateCategory, deleteCategory, ApiError } from '../api';
import { makeQueryClient } from '../queryClient';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
let fetchMock: jest.Mock;

const CAP = 'a category can have at most 50 sub-categories';
const respond = (status: number, json: () => Promise<unknown>) =>
  Promise.resolve({ ok: false, status, json });

beforeEach(() => {
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockResolvedValue('tok');
  fetchMock = jest.fn();
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

const create = () => createCategory({ name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' });

describe('the reason reaches the caller', () => {
  it('createCategory carries a 400 refusal', async () => {
    fetchMock.mockReturnValue(respond(400, () => Promise.resolve({ error: CAP })));
    await expect(create()).rejects.toMatchObject({ message: 'API error: 400', status: 400, serverMessage: CAP });
  });

  it('updateCategory carries a 400 refusal', async () => {
    fetchMock.mockReturnValue(respond(400, () => Promise.resolve({ error: CAP })));
    await expect(updateCategory('gym', { name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell' }))
      .rejects.toMatchObject({ status: 400, serverMessage: CAP });
  });

  it('deleteCategory carries the too-wide-to-detach refusal', async () => {
    const detach = "'cafes-coffee' has 73 sub-categories — too many to detach in one write; move some out from under it first";
    fetchMock.mockReturnValue(respond(400, () => Promise.resolve({ error: detach })));
    await expect(deleteCategory('cafes-coffee')).rejects.toMatchObject({ status: 400, serverMessage: detach });
  });

  it('carries a 409 duplicate — the most common real save failure', async () => {
    fetchMock.mockReturnValue(respond(409, () => Promise.resolve({ error: 'category already exists' })));
    await expect(create()).rejects.toMatchObject({ status: 409, serverMessage: 'category already exists' });
  });
});

describe('the reader is total — it never throws, whatever comes back', () => {
  it.each([
    ['an HTML gateway page', 403, () => Promise.reject(new SyntaxError('Unexpected token <'))],
    ['an empty body', 502, () => Promise.reject(new SyntaxError('Unexpected end of JSON input'))],
    ['a null body', 400, () => Promise.resolve(null)],
    ['a non-string error field', 400, () => Promise.resolve({ error: { code: 1 } })],
    ['a whitespace-only error', 400, () => Promise.resolve({ error: '   ' })],
    ['no error key at all', 401, () => Promise.resolve({ message: 'Unauthorized' })],
  ])('%s still yields a status-only ApiError', async (_label, status, json) => {
    fetchMock.mockReturnValue(respond(status, json));
    await expect(create()).rejects.toMatchObject({ message: `API error: ${status}`, status, serverMessage: null });
  });

  it('a response with no json() at all is still a status-only ApiError', async () => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, status: 502 }));
    await expect(create()).rejects.toMatchObject({ message: 'API error: 502', serverMessage: null });
  });
});

describe('the auth-retry gate still recognises the error', () => {
  // Pinned against the REAL client rather than a copied regex: if the message ever stops carrying
  // the status, an expired session would be retried three times with backoff instead of bailing.
  it.each([401, 403])('does not retry a %s carrying a server body', async (status) => {
    fetchMock.mockReturnValue(respond(status, () => Promise.resolve({ error: 'nope' })));
    const error = await create().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const retry = makeQueryClient().getDefaultOptions().queries?.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, error)).toBe(false);
  });

  it('still retries a 500', async () => {
    fetchMock.mockReturnValue(respond(500, () => Promise.resolve({ error: 'boom' })));
    const error = await create().catch((e: unknown) => e);
    const retry = makeQueryClient().getDefaultOptions().queries?.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, error)).toBe(true);
  });
});
