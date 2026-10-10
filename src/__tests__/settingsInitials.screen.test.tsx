// WHIT-180 — edge cases for the exported initialsFrom helper (avatar fallback). Run
// under the screen preset so the Settings module's react-native imports resolve; the
// helper itself is pure, so no render is needed. Covers multi-space / single-word /
// whitespace-only names, the email @-strip, and the empty fallback.
import { it, expect, jest } from '@jest/globals';

// Importing the Settings module pulls in its top-level deps; mock the native-backed
// ones so the module loads in the test env (we only exercise the pure initialsFrom).
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../../src/auth', () => ({ signOut: jest.fn(), getCurrentUser: () => null }));
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({})));

import { initialsFrom } from '../../app/settings';

it.each([
  ['two-word name → first + last initial', { name: 'Jasmine Nguyen' }, 'JN'],
  ['padded / multi-space name → first + last initial only', { name: '  Jasmine   Marie   Nguyen  ' }, 'JN'],
  ['single-word name → one initial', { name: 'Jasmine' }, 'J'],
  ['whitespace-only name falls through to the email initials', { name: '   ', email: 'zoe@x.com' }, 'ZO'],
  ['email initials strip @/dots so they never show "X@"', { email: 'x@y.com' }, 'XY'],
  ['nothing usable (null) → "?"', null, '?'],
  ['nothing usable ({}) → "?"', {}, '?'],
  ['nothing usable (blank name) → "?"', { name: '   ' }, '?'],
])('initialsFrom: %s', (_case, user, expected) => {
  expect(initialsFrom(user)).toBe(expected);
});
