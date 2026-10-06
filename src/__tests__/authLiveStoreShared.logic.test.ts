// WHIT-786 (slice 2) — the live signed-in/locked/signed-out switch lives once, in
// support/authMock.ts. Fail-on-revert: paste a hand-rolled listener store back into a suite that
// mocks the auth module and this goes red, naming the file and line.
// authGate.screen keeps its own bespoke stand-in; sessionEpochAccessor keeps the guarded
// (skip-if-unchanged) broadcast the shared switch deliberately doesn't model.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { TESTS_DIR, testFiles } from './support/sourceScan';

const SELF = basename(__filename);
const ALLOWED = new Set([
  SELF,
  'authGate.screen.test.tsx',
  'sessionEpochAccessor.provider.screen.test.tsx',
]);

// Built from parts so this file never contains the text it hunts for.
const MOCKS_AUTH = 'jest.mock(' + "'../auth'";
const LOCAL_STORE = new RegExp('\\b(mock' + 'Listeners|mockAuth' + 'Listeners)\\s*=\\s*new\\s+Set\\b');

function liveStoreCopies(): string[] {
  return testFiles(TESTS_DIR)
    .filter((file) => !ALLOWED.has(file))
    .flatMap((file) => {
      const source = readFileSync(join(TESTS_DIR, file), 'utf8');
      if (!source.includes(MOCKS_AUTH)) return [];
      return source
        .split('\n')
        .flatMap((line, index) => (LOCAL_STORE.test(line) ? [`${file}:${index + 1}`] : []));
    });
}

describe('the live sign-in switch is shared, not copied', () => {
  it('no suite that mocks the auth module builds its own listener store', () => {
    expect(liveStoreCopies()).toEqual([]);
  });
});
