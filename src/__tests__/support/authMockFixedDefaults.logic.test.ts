// WHIT-786 (slice 3) — the ~60 suites that swapped a fixed "always signed in" fake for
// authMockModule() never call resetAuth(): they rely on a freshly loaded store already being
// signed in, with the same token the old fakes hard-coded. Pin that start state directly.
import { it, expect, jest } from '@jest/globals';

// [A1] Fail-on-revert: start the store at 'loading' (or with no token) → this goes red.
it('a freshly loaded shared switch is signed in with the old fixed token, before any reset', async () => {
  let fresh: typeof import('./authMock') | undefined;
  jest.isolateModules(() => {
    fresh = require('./authMock');
  });
  const auth = fresh!.authMockModule();

  expect(auth.getStatus()).toBe('authed');
  await expect(auth.getAuthToken()).resolves.toBe('test-id-token');
});
