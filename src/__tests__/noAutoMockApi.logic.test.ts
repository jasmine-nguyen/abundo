// No test may use the bare `jest.mock('../api')` auto-mock: it skips the real request code
// (src/api.ts). Suites use `installFakeServer()` instead. WHIT-640 widens this to factory mocks.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const API_AUTO_MOCK = /^\s*jest\.mock\(\s*['"](\.\.\/)+api['"]\s*\)/m;

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
  it('no test file auto-mocks the api', () => {
    const offenders = testFiles(__dirname).filter(autoMocksApi);

    expect(offenders).toEqual([]);
  });

  it('the moved save and big-screen suites run on the fake server and keep their expect( count', () => {
    const baselines: Record<string, number> = {
      'loanFactsWrite.provider.screen.test.tsx': 8,
      'goalsWrite.provider.screen.test.tsx': 53,
      'goalSaveCoexistence.provider.screen.test.tsx': 3,
      'optimisticSaveWriters.provider.screen.test.tsx': 49,
      'budgetTxOptimistic.provider.screen.test.tsx': 64,
      'budgetTxEditGaps.provider.screen.test.tsx': 9,
      'whit525Gaps.provider.screen.test.tsx': 7,
      'appProvider.screen.test.tsx': 101,
      'overlaysRealData.screen.test.tsx': 100,
    };

    const shortfalls = Object.entries(baselines).flatMap(([file, baseline]) => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const expectLines = source.split('\n').filter((line) => line.includes('expect(')).length;
      const problems: string[] = [];
      if (!/installFakeServer\(\)/.test(source)) problems.push(`${file}: no installFakeServer()`);
      if (expectLines < baseline) problems.push(`${file}: expect( ${expectLines} < ${baseline}`);
      return problems;
    });

    expect(shortfalls).toEqual([]);
  });

  it('the pattern catches the bare auto-mock and ignores factory mocks and comments', () => {
    expect(`jest.mock('../api');`).toMatch(API_AUTO_MOCK);
    expect(`import x from 'y';\n  jest.mock("../../api")`).toMatch(API_AUTO_MOCK);
    expect(`jest.mock('../api', () => ({}));`).not.toMatch(API_AUTO_MOCK);
    expect(`// used instead of jest.mock('../api')`).not.toMatch(API_AUTO_MOCK);
  });
});
