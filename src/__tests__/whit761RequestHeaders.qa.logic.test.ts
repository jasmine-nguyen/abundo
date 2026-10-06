// WHIT-761 QA — request() now builds its headers inline. The token is read before every call,
// so two calls never share headers.
import { it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));

import { getAuthToken } from '../auth';
import { fetchCategories, createCategory } from '../api';

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

// [A4]
it('each call reads a fresh token and calls never share headers', async () => {
  mockGetAuthToken.mockResolvedValueOnce('first').mockResolvedValueOnce('second');
  await createCategory({ name: 'Gym', bucket: 'Lifestyle' as never, icon: 'dumbbell' });
  await fetchCategories();
  expect(sentHeaders(0)).toEqual({ Authorization: 'Bearer first', 'Content-Type': 'application/json' });
  expect(sentHeaders(1)).toEqual({ Authorization: 'Bearer second' });
});
