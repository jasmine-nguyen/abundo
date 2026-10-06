// WHIT-786 (slice 4) — the token-only sign-in pass fake lives once, in support/authMock.ts
// (authTokenSpyModule). Fail-on-revert: paste a hand-written token spy back into a suite's
// auth-module mock and this goes red, naming the file and line.
import { describe, it, expect } from '@jest/globals';
import { authMockOffenders } from './support/authMockScan';

// Built from parts so this file never contains the text it hunts for.
const LOCAL_TOKEN_SPY = new RegExp('\\bgetAuth' + 'Token\\s*:\\s*jest\\.' + 'fn\\b');

describe('the sign-in pass fake is shared, not copied', () => {
  it('no suite that mocks the auth module writes its own token spy', () => {
    expect(authMockOffenders((line) => LOCAL_TOKEN_SPY.test(line))).toEqual([]);
  });
});
