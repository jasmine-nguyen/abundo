// WHIT-786 (slice 2) QA — [A1] the live-store guard (authLiveStoreShared) only spots a store named
// mockListeners/mockAuthListeners declared as `= new Set`, in a file mocking '../auth'. A copy-back
// typed as `: Set<() => void> = new Set()`, given another name, or in a nested suite mocking
// '../../auth' slips past it. This catches any listener set in any suite that mocks the auth module.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { TESTS_DIR, testFiles } from './support/sourceScan';

const ALLOWED = new Set([
  basename(__filename),
  'support/authMock.ts',
  'authGate.screen.test.tsx',
  'sessionEpochAccessor.provider.screen.test.tsx',
]);

// Built from parts so this file never contains the text it hunts for.
const MOCKS_AUTH = new RegExp('jest\\.mock\\(\\s*[\'"](\\.\\./)+' + 'auth[\'"]');
const LISTENER_SET = new RegExp('(new\\s+Set|:\\s*Set)\\s*<\\s*\\(\\)\\s*=>\\s*' + 'void\\s*>');

describe('[A1] no suite that mocks the auth module keeps its own listener set', () => {
  it('finds no listener set outside support/authMock and the allow-list', () => {
    const offenders = testFiles(TESTS_DIR)
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => {
        const source = readFileSync(join(TESTS_DIR, file), 'utf8');
        return MOCKS_AUTH.test(source) && LISTENER_SET.test(source);
      });
    expect(offenders).toEqual([]);
  });
});
