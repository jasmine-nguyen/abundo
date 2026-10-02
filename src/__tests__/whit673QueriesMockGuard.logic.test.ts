// WHIT-673 acceptance: a repo-wide ratchet stops new tests faking the screen data code (src/queries.ts),
// and the layout/animation-only suites are deleted rather than allow-listed.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';
import { QUERIES_MOCK } from './noQueriesMock.logic.test';

const DELETED_LAYOUT_ONLY = [
  'motionScroll.screen.test.tsx',
  'tabScreensMotionScroll.screen.test.tsx',
  'segPressState.screen.test.tsx',
  'tabScreensClearance.screen.test.tsx',
];

describe('WHIT-673 no new test fakes the screen data code', () => {
  it('every test still faking the screen data code is on the guard allow-list, and the layout-only suites are gone', () => {
    const files = testFiles(__dirname);

    expect(files).toContain('support/sourceScan.ts');
    expect(files).toContain('noQueriesMock.logic.test.ts');
    expect(files).toContain('whit673QueriesMockGuard.logic.test.ts');
    expect(files.filter((file) => file.startsWith('..') || file.includes('\\'))).toEqual([]);

    for (const file of DELETED_LAYOUT_ONLY) {
      expect(existsSync(join(__dirname, file))).toBe(false);
    }

    const guardSource = readFileSync(join(__dirname, 'noQueriesMock.logic.test.ts'), 'utf8');
    const offenders = files.filter((file) => QUERIES_MOCK.test(readFileSync(join(__dirname, file), 'utf8')));
    const unlisted = offenders.filter((file) => !guardSource.includes(`'${file}'`));
    expect(unlisted).toEqual([]);
  });

  it('the pattern catches every way of writing the queries mock and ignores comments and look-alikes', () => {
    expect(`jest.mock('../queries', () => ({}))`).toMatch(QUERIES_MOCK);
    expect(`jest.mock('../../src/queries', () => ({ useX: jest.fn() }))`).toMatch(QUERIES_MOCK);
    expect(`jest.doMock("../queries")`).toMatch(QUERIES_MOCK);
    expect(`\tjest.mock('../queries', () => ({}));`).toMatch(QUERIES_MOCK);
    expect(`import x from 'y';\njest.mock(\n  '../queries',\n  () => ({}),\n);`).toMatch(QUERIES_MOCK);

    expect(`// jest.mock('../queries')`).not.toMatch(QUERIES_MOCK);
    expect(`jest.mock('../queryClient')`).not.toMatch(QUERIES_MOCK);
    expect(`jest.mock('./support/queries')`).not.toMatch(QUERIES_MOCK);
    expect(`jest.mock('../queriesX')`).not.toMatch(QUERIES_MOCK);
    expect(`const hint = "jest.mock('../queries')";`).not.toMatch(QUERIES_MOCK);
  });
});
