// WHIT-786 (slice 2) — the live signed-in/locked/signed-out switch lives once, in
// support/authMock.ts. Fail-on-revert: paste a hand-rolled listener store back into a suite that
// mocks the auth module (at any depth) — by the usual names or as any `Set<() => void>` — and this
// goes red, naming the file and line.
import { describe, it, expect } from '@jest/globals';
import { authMockOffenders } from './support/authMockScan';

// Built from parts so this file never contains the text it hunts for.
const LOCAL_STORE = new RegExp('\\b(mock' + 'Listeners|mockAuth' + 'Listeners)\\s*=\\s*new\\s+Set\\b');
const LISTENER_SET = new RegExp('(new\\s+Set|:\\s*Set)\\s*<\\s*\\(\\)\\s*=>\\s*' + 'void\\s*>');

describe('the live sign-in switch is shared, not copied', () => {
  it('no suite that mocks the auth module builds its own listener store', () => {
    expect(authMockOffenders((line) => LOCAL_STORE.test(line) || LISTENER_SET.test(line))).toEqual([]);
  });
});
