// No test may use the bare `jest.mock('../api')` auto-mock: it skips the real request code
// (src/api.ts). Suites use `installFakeServer()` instead. WHIT-640 widens this to factory mocks.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const API_AUTO_MOCK = /^\s*jest\.mock\(\s*['"](\.\.\/)+api['"]\s*\)/m;

// Shrinks as later cards move these suites onto the fake server; deleted once empty.
const STILL_TO_MOVE = [
  // WHIT-656
  'loanFactsWrite.provider.screen.test.tsx',
  'goalsWrite.provider.screen.test.tsx',
  'goalSaveCoexistence.provider.screen.test.tsx',
  'optimisticSaveWriters.provider.screen.test.tsx',
  'budgetTxOptimistic.provider.screen.test.tsx',
  'budgetTxEditGaps.provider.screen.test.tsx',
  'whit525Gaps.provider.screen.test.tsx',
  // WHIT-657
  'appProvider.screen.test.tsx',
  'overlaysRealData.screen.test.tsx',
];

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [relative(__dirname, path)];
  });
}

function autoMocksApi(file: string): boolean {
  return API_AUTO_MOCK.test(readFileSync(join(__dirname, file), 'utf8'));
}

describe('no test uses the bare api auto-mock', () => {
  it('no file outside the still-to-move list auto-mocks the api', () => {
    const offenders = testFiles(__dirname).filter(
      (file) => autoMocksApi(file) && !STILL_TO_MOVE.includes(file),
    );

    expect(offenders).toEqual([]);
  });

  it('every file on the still-to-move list still auto-mocks the api, so the list only shrinks', () => {
    const alreadyMoved = STILL_TO_MOVE.filter((file) => !autoMocksApi(file));

    expect(alreadyMoved).toEqual([]);
  });

  it('the pattern catches the bare auto-mock and ignores factory mocks and comments', () => {
    expect(`jest.mock('../api');`).toMatch(API_AUTO_MOCK);
    expect(`import x from 'y';\n  jest.mock("../../api")`).toMatch(API_AUTO_MOCK);
    expect(`jest.mock('../api', () => ({}));`).not.toMatch(API_AUTO_MOCK);
    expect(`// used instead of jest.mock('../api')`).not.toMatch(API_AUTO_MOCK);
  });
});
