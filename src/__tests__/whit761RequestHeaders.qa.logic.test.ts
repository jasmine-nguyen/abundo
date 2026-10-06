// WHIT-761 QA — request() now builds its headers inline. A read must send ONLY the auth header
// (no Content-Type); a write with a body sends both. The token is read before every call.
import { it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule());

import { getAuthToken } from '../auth';
import { fetchCategories, deleteCategory, createCategory } from '../api';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
let fetchMock: jest.Mock;

function sentHeaders(call = 0): Record<string, string> {
  return (fetchMock.mock.calls[call] as [string, { headers: Record<string, string> }])[1].headers;
}

beforeEach(() => {
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockResolvedValue('tok');
  fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) }));
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

// [A1]
it('a read sends only the Authorization header', async () => {
  await fetchCategories();
  expect(sentHeaders()).toEqual({ Authorization: 'Bearer tok' });
});

// [A2]
it('a DELETE with no body sends no Content-Type', async () => {
  await deleteCategory('gym');
  expect(sentHeaders()).toEqual({ Authorization: 'Bearer tok' });
});

// [A3, A4]
it('a write sends Authorization and Content-Type, each call reads a fresh token and calls never share headers', async () => {
  mockGetAuthToken.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
  await createCategory({ name: 'Gym', bucket: 'Lifestyle' as never, icon: 'dumbbell' });
  await fetchCategories();
  expect(sentHeaders(0)).toEqual({ Authorization: 'Bearer first', 'Content-Type': 'application/json' });
  expect(sentHeaders(1)).toEqual({ Authorization: 'Bearer second' });
});
