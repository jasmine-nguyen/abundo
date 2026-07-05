// WHIT-180 — edge cases for the exported initialsFrom helper (avatar fallback). Run
// under the screen preset so the Settings module's react-native imports resolve; the
// helper itself is pure, so no render is needed. Covers multi-space / single-word /
// whitespace-only names, the email @-strip, and the empty fallback.
import { describe, it, expect, jest } from '@jest/globals';

// Importing the Settings module pulls in its top-level deps; mock the native-backed
// ones so the module loads in the test env (we only exercise the pure initialsFrom).
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn(), push: jest.fn() }) }));
jest.mock('../../src/auth', () => ({ signOut: jest.fn(), getCurrentUser: () => null }));
jest.mock('../../src/context', () => ({ loanFactsReady: () => false, useAppContext: () => ({}) }));

import { initialsFrom } from '../../app/(tabs)/settings';

describe('initialsFrom', () => {
  it('two-word name → first + last initial', () => {
    expect(initialsFrom({ name: 'Jasmine Nguyen' })).toBe('JN');
  });

  it('padded / multi-space name → first + last initial only', () => {
    expect(initialsFrom({ name: '  Jasmine   Marie   Nguyen  ' })).toBe('JN');
  });

  it('single-word name → one initial', () => {
    expect(initialsFrom({ name: 'Jasmine' })).toBe('J');
  });

  it('whitespace-only name falls through to the email initials', () => {
    expect(initialsFrom({ name: '   ', email: 'zoe@x.com' })).toBe('ZO');
  });

  it('email initials strip @/dots so they never show "X@"', () => {
    expect(initialsFrom({ email: 'x@y.com' })).toBe('XY');
  });

  it('nothing usable → "?"', () => {
    expect(initialsFrom(null)).toBe('?');
    expect(initialsFrom({})).toBe('?');
    expect(initialsFrom({ name: '   ' })).toBe('?');
  });
});
