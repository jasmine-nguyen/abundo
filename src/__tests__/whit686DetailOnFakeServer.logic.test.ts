// WHIT-686 slice 1: the transaction detail screen suites run the real screen data code over the
// pretend server, and are off the allow-list in noQueriesMock.logic.test.ts.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const QUERIES_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/m;

const SLICE_FILES = [
  'transactionDetail.screen.test.tsx',
  'transactionDetailDeleteGaps.screen.test.tsx',
  'transactionEdit.screen.test.tsx',
  'transactionSpread.gap.screen.test.tsx',
  'whit330Transactions.screen.test.tsx',
];

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

describe('transaction detail screen suites use the pretend server', () => {
  it('each suite draws the real screen over the pretend server instead of faking the screen data code', () => {
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

  it('none of the moved suites is left on the allow-list', () => {
    const allowList = source('noQueriesMock.logic.test.ts');
    expect(SLICE_FILES.filter((file) => allowList.includes(`'${file}'`))).toEqual([]);
  });
});
