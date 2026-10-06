// WHIT-786 (slice 3) — the fixed "always signed in" stand-in and the quietly changed status live
// once, in support/authMock.ts (authMockModule, setAuthStatusQuietly). Fail-on-revert: paste a
// hand-written status reader back into a suite's auth-module mock and this goes red, naming the
// file and line.
// authGate.screen keeps its own bespoke stand-in; sessionEpochAccessor keeps the guarded
// (skip-if-unchanged) broadcast the shared switch deliberately doesn't model.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { TESTS_DIR, testFiles } from './support/sourceScan';

const SELF = basename(__filename);
const ALLOWED = new Set([
  SELF,
  'support/authMock.ts',
  'authGate.screen.test.tsx',
  'sessionEpochAccessor.provider.screen.test.tsx',
]);

// Built from parts so this file never contains the text it hunts for.
const MOCKS_AUTH = new RegExp('jest\\.mock\\(\\s*[\'"](\\.\\./)+' + 'auth[\'"]');
const LOCAL_STATUS = new RegExp('\\bget' + 'Status\\s*:\\s*(async\\s*)?\\(\\s*\\)\\s*=>');

function statusCopies(): string[] {
  return testFiles(TESTS_DIR)
    .filter((file) => !ALLOWED.has(file))
    .flatMap((file) => {
      const source = readFileSync(join(TESTS_DIR, file), 'utf8');
      if (!MOCKS_AUTH.test(source)) return [];
      return source.split('\n').flatMap((line, index) => {
        if (!LOCAL_STATUS.test(line)) return [];
        return [`${file}:${index + 1}`];
      });
    });
}

describe('the fixed sign-in status is shared, not copied', () => {
  it('no suite that mocks the auth module writes its own status reader', () => {
    expect(statusCopies()).toEqual([]);
  });
});
