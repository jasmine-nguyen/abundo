// WHIT-162 — getAuthToken THROWS (not just returns undefined). authHeaders awaits
// it, so the rejection must propagate out of the fetcher and fetch must NOT be
// called (no empty-Bearer request). The implementer's apiCoreAuth suite only
// covers the resolves-undefined path; this locks the throw path. '../auth' + fetch
// mocked.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));

import { getAuthToken } from '../auth';
import { fetchTransactions, setPayCycle } from '../api';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
let fetchMock: jest.Mock;

beforeEach(() => {
  mockGetAuthToken.mockReset();
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('getAuthToken rejection propagates and blocks the request', () => {
  it('a read fetcher rejects with the original error and never calls fetch', async () => {
    mockGetAuthToken.mockRejectedValue(new Error('token store exploded'));
    await expect(fetchTransactions()).rejects.toThrow('token store exploded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a write fetcher rejects with the original error and never calls fetch', async () => {
    mockGetAuthToken.mockRejectedValue(new Error('token store exploded'));
    await expect(setPayCycle({ length: 14, last_pay_date: '2026-06-06' })).rejects.toThrow(
      'token store exploded',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
