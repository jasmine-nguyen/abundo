// WHIT-786 (slice 3) — the fixed "always signed in" stand-in and the quietly changed status live
// once, in support/authMock.ts (authMockModule, setAuthStatusQuietly). Fail-on-revert: paste a
// hand-written status reader back into a suite's auth-module mock and this goes red, naming the
// file and line.
import { describe, it, expect } from '@jest/globals';
import { authMockOffenders } from './support/authMockScan';

// Built from parts so this file never contains the text it hunts for.
const LOCAL_STATUS = new RegExp('\\bget' + 'Status\\s*:\\s*(async\\s*)?\\(\\s*\\)\\s*=>');

describe('the fixed sign-in status is shared, not copied', () => {
  it('no suite that mocks the auth module writes its own status reader', () => {
    expect(authMockOffenders((line) => LOCAL_STATUS.test(line))).toEqual([]);
  });
});
