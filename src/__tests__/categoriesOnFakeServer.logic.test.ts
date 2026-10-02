// WHIT-688 slice 3: the category drill-in, category edit and full-parent picker suites run the real
// screen data code over the fake server, and the last three files are off the shrink-only allow-list.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { QUERIES_MOCK } from './noQueriesMock.logic.test';

const SLICE_FILES = [
  'categoryDetail.screen.test.tsx',
  'categoryEditSummaryToast.screen.test.tsx',
  'categoryFields.screen.test.tsx',
];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function allowList(): string[] {
  const body = read('noQueriesMock.logic.test.ts').match(/const ALLOWED = new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!body) throw new Error('ALLOWED not found in noQueriesMock.logic.test.ts');
  return [...body[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('Category screen tests run the real screen data code', () => {
  it('the three category files are off the allow-list and none fakes the screen data code', () => {
    expect(SLICE_FILES.filter((file) => allowList().includes(file))).toEqual([]);
    expect(SLICE_FILES.filter((file) => !existsSync(join(__dirname, file)) || QUERIES_MOCK.test(read(file)))).toEqual(
      [],
    );
  });

  it('the category suites draw over the fake server, with the real category selector and the shared sign-in stand-in', () => {
    const notOnFakeServer = SLICE_FILES.filter((file) => {
      const source = read(file);
      return !/installFakeServer\(\)/.test(source) || !/renderWithQueries|renderLoaded/.test(source);
    });
    expect(notOnFakeServer).toEqual([]);

    // The drill-in's total and groups must come from the real categoryTransactions selector.
    expect(read('categoryDetail.screen.test.tsx')).not.toMatch(/^\s*categoryTransactions\s*:/m);

    // The edit screen signs in through the shared stand-in, not a hand-made auth stub.
    expect(read('categoryEditSummaryToast.screen.test.tsx')).toMatch(/authMockModule\(\)/);
  });
});
