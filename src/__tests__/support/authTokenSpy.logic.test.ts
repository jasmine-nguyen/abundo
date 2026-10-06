// WHIT-786 (slice 4) — the token-only sign-in pass fake for the server-call suites lives once, in
// support/authMock.ts (authTokenSpyModule). Each suite keeps its own pass value ('test-token',
// 'tok' or none) and can still reconfigure the spy per test.
import { describe, it, expect, jest } from '@jest/globals';
import { authTokenSpyModule } from './authMock';

describe('WHIT-786 shared sign-in pass fake for server-call tests', () => {
  it.each([
    ['test-token', 'test-token'],
    ['tok', 'tok'],
    [undefined, undefined],
  ])('hands out the suite’s own pass (%s) from a spy the test can reconfigure', async (token, expected) => {
    const { getAuthToken } = authTokenSpyModule(token);

    expect(jest.isMockFunction(getAuthToken)).toBe(true);
    await expect(getAuthToken()).resolves.toBe(expected);
    expect(getAuthToken).toHaveBeenCalledTimes(1);

    getAuthToken.mockResolvedValueOnce('other-pass');
    await expect(getAuthToken()).resolves.toBe('other-pass');
  });

  it('each call gives a fresh spy, so suites never share call counts', async () => {
    const first = authTokenSpyModule('tok').getAuthToken;
    await first();

    expect(authTokenSpyModule('tok').getAuthToken).not.toHaveBeenCalled();
  });
});
