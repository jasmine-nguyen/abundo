// WHIT-786 — shared scan for the "sign-in stand-in lives once" guards: every `file:line` matching
// `match` in a test file that mocks the auth module (at any depth). authGate.screen keeps its own
// bespoke stand-in; sessionEpochAccessor keeps the guarded (skip-if-unchanged) broadcast the shared
// switch deliberately doesn't model.
import { readFileSync } from 'fs';
import { join } from 'path';
import { TESTS_DIR, findOffenders, testFiles } from './sourceScan';

const ALLOWED = ['support/authMock.ts', 'authGate.screen.test.tsx', 'sessionEpochAccessor.provider.screen.test.tsx'];

// Built from parts so this file never contains the text it hunts for.
const MOCKS_AUTH = new RegExp('jest\\.mock\\(\\s*[\'"](\\.\\./)+' + 'auth[\'"]');

export function authMockOffenders(match: (line: string) => boolean): string[] {
  const notMockingAuth = testFiles(TESTS_DIR).filter(
    (file) => !MOCKS_AUTH.test(readFileSync(join(TESTS_DIR, file), 'utf8')),
  );
  return findOffenders(match, new Set([...ALLOWED, ...notMockingAuth]));
}
