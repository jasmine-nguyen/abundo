// WHIT-786 — the sign-in stand-ins live once, in support/authMock.ts: the live signed-in/locked/
// signed-out switch, the fixed "always signed in" status (authMockModule, setAuthStatusQuietly) and
// the token-only sign-in pass (authTokenSpyModule). Fail-on-revert: paste a hand-written copy back
// into a suite that mocks the auth module (at any depth) and this goes red, naming the file and line.
import { describe, it, expect } from '@jest/globals';
import { authMockOffenders } from './support/authMockScan';

// Built from parts so this file never contains the text it hunts for.
const LOCAL_STORE = new RegExp('\\b(mock' + 'Listeners|mockAuth' + 'Listeners)\\s*=\\s*new\\s+Set\\b');
const LISTENER_SET = new RegExp('(new\\s+Set|:\\s*Set)\\s*<\\s*\\(\\)\\s*=>\\s*' + 'void\\s*>');
const LOCAL_STATUS = new RegExp('\\bget' + 'Status\\s*:\\s*(async\\s*)?\\(\\s*\\)\\s*=>');
const LOCAL_TOKEN_SPY = new RegExp('\\bgetAuth' + 'Token\\s*:\\s*jest\\.' + 'fn\\b');

describe('the sign-in stand-ins are shared, not copied', () => {
  it.each([
    ['listener store', (line: string) => LOCAL_STORE.test(line) || LISTENER_SET.test(line)],
    ['status reader', (line: string) => LOCAL_STATUS.test(line)],
    ['token spy', (line: string) => LOCAL_TOKEN_SPY.test(line)],
  ])('no suite that mocks the auth module writes its own %s', (_label, match) => {
    expect(authMockOffenders(match)).toEqual([]);
  });
});
