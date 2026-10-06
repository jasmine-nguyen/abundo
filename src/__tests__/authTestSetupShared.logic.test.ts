// WHIT-786 — the sign-in test setup lives once, in support/authModule.ts: the saved-login key
// names, the clock tool, loadAuth, the fake session and the native-module mock builders (keychain,
// Hosted UI, Cognito SDK). Fail-on-revert: paste a local copy back into any test file and this goes
// red, naming the file and line.
import { describe, it, expect } from '@jest/globals';
import { basename } from 'path';
import { findOffenders } from './support/sourceScan';

const ALLOWED = ['support/authModule.ts', basename(__filename)];

// Built from parts so this file never contains the text it hunts for.
const KEY_PREFIX = 'abundo' + '\\.cognito\\.';
const LOCAL_KEY = new RegExp(`const\\s+\\w+\\s*=\\s*['"]${KEY_PREFIX}(refreshToken|hasSession|authMethod)['"]`);
const localHelper = (name: string) => new RegExp(`(function\\s+${name}\\b|const\\s+${name}\\s*=)`);
const handWrittenMock = (module: string) =>
  new RegExp(`jest\\.mock\\(\\s*['"]${module}['"]\\s*,\\s*\\(\\)\\s*=>\\s*\\(\\s*\\{`);

describe('sign-in test setup is shared, not copied', () => {
  it.each([
    ['a saved-login key name', LOCAL_KEY, []],
    ['nowSec', localHelper('now' + 'Sec'), []],
    ['loadAuth', localHelper('load' + 'Auth'), []],
    ['fakeSession', localHelper('fake' + 'Session'), []],
    ['expo-secure-store mock', handWrittenMock('expo-secure-store'), []],
    ['expo-auth-session mock', handWrittenMock('expo-auth-session'), []],
    // authForgotPassword models forgotPassword/confirmPassword and a constructor spy cognitoMock doesn't.
    ['amazon-cognito-identity-js mock', handWrittenMock('amazon-cognito-identity-js'), ['authForgotPassword.logic.test.ts']],
  ])('no test file defines its own %s', (_label, pattern, extraAllowed) => {
    expect(findOffenders((line) => pattern.test(line), new Set([...ALLOWED, ...extraAllowed]))).toEqual([]);
  });
});
