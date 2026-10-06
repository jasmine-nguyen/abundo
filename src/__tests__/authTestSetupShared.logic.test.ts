// WHIT-786 — the sign-in test setup lives once, in support/authModule.ts: the saved-login key
// names, the clock tool, loadAuth and the fake session. Fail-on-revert: paste a local copy back
// into any test file and this goes red, naming the file and line.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { TESTS_DIR, findOffenders } from './support/sourceScan';

const HOME = 'support/authModule.ts';
const SELF = basename(__filename);
const ALLOWED = new Set([HOME, SELF]);

// Built from parts so this file never contains the text it hunts for.
const KEY_PREFIX = 'abundo' + '\\.cognito\\.';
const LOCAL_KEY = new RegExp(`const\\s+\\w+\\s*=\\s*['"]${KEY_PREFIX}(refreshToken|hasSession|authMethod)['"]`);
const localHelper = (name: string) => new RegExp(`(function\\s+${name}\\b|const\\s+${name}\\s*=)`);

describe('sign-in test setup is shared, not copied', () => {
  it('support/authModule.ts exports the shared setup', () => {
    const source = readFileSync(join(TESTS_DIR, HOME), 'utf8');
    for (const name of [
      'REFRESH_KEY',
      'SENTINEL_KEY',
      'METHOD_KEY',
      'nowSec',
      'loadAuth',
      'fakeSession',
      'secureStoreMock',
      'memorySecureStoreMock',
      'authSessionMock',
      'cognitoMock',
    ]) {
      expect(source).toMatch(new RegExp(`export\\s+(async\\s+)?(function|const)\\s+${name}\\b`));
    }
  });

  it.each([
    ['a saved-login key name', LOCAL_KEY],
    ['nowSec', localHelper('now' + 'Sec')],
    ['loadAuth', localHelper('load' + 'Auth')],
    ['fakeSession', localHelper('fake' + 'Session')],
  ])('no test file defines its own %s', (_label, pattern) => {
    expect(findOffenders((line) => pattern.test(line), ALLOWED)).toEqual([]);
  });
});
