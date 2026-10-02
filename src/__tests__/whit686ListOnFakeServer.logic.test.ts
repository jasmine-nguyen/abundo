// WHIT-686 slice 2: the Transactions list suites run the real screen data code over the pretend
// server, and are off the allow-list in noQueriesMock.logic.test.ts.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const QUERIES_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/m;

const SLICE_FILES = [
  'transactionsScreenStates.screen.test.tsx',
  'transactionsSearchGaps.screen.test.tsx',
  'transactionsSearchServer.screen.test.tsx',
  'transactionsAccountsRemoved.screen.test.tsx',
  'whit328SelectGap.screen.test.tsx',
];

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

describe('Transactions list suites use the pretend server', () => {
  it('each suite draws the real Transactions tab over the pretend server instead of faking the screen data code', () => {
    const problems = SLICE_FILES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: still fakes the screen data code`);
      if (!text.includes('installFakeServer(')) found.push(`${file}: does not install the pretend server`);
      if (!text.includes('renderWithQueries')) found.push(`${file}: does not draw with renderWithQueries`);
      if (!text.includes('authMock')) found.push(`${file}: does not use authMock`);
      return found;
    });
    expect(problems).toEqual([]);
  });

  it('none of the moved suites is left on the allow-list, and the layout-only pull-spinner offset test is gone', () => {
    const allowList = source('noQueriesMock.logic.test.ts');
    expect(SLICE_FILES.filter((file) => allowList.includes(`'${file}'`))).toEqual([]);
    const states = source('transactionsScreenStates.screen.test.tsx');
    expect(states).not.toContain('offsets the pull spinner below the floating header');
    expect(states).not.toContain('HEADER_BODY_HEIGHT');
  });
});
