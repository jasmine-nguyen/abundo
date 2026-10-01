// WHIT-672 — the budget and loan screen suites draw the real screens over the fake server instead
// of hand-written query shapes, each keeps its minimum expect( count in the noAutoMockApi
// baselines, and the old shared query-shapes file is gone with nothing left loading it.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const MOVED_SUITES = [
  'budgetDetailLoadMore.screen.test.tsx',
  'budgetEditSave.screen.test.tsx',
  'budgetSpread.screen.test.tsx',
  'budgetSpreadGaps.screen.test.tsx',
  'loanCeilingCopy.screen.test.tsx',
  'loanFactsForm.screen.test.tsx',
  'loanFactsForm.edit.screen.test.tsx',
  'loanFactsFormEdges.screen.test.tsx',
];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const OLD_SHAPES = ['screen', 'Query', 'Mocks'].join('');
const OLD_SHAPES_LOADS = [
  ["require('./support/", OLD_SHAPES, "')"].join(''),
  ["from './support/", OLD_SHAPES, "'"].join(''),
];

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [relative(__dirname, path)];
  });
}

describe('WHIT-672 budget and loan suites run on the fake server', () => {
  it('each moved suite uses the real queries over the fake server and is pinned in the baselines', () => {
    const baselines = source('noAutoMockApi.logic.test.ts');

    const problems = MOVED_SUITES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: mocks ../queries`);
      if (text.includes(OLD_SHAPES)) found.push(`${file}: uses the hand-written query shapes`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!/from ['"]\.\/support\/renderWithQueries['"]/.test(text)) found.push(`${file}: does not draw via support/renderWithQueries`);
      if (!/resetAuth\(\)/.test(text)) found.push(`${file}: no resetAuth()`);
      if (!baselines.includes(`'${file}':`)) found.push(`${file}: not in the noAutoMockApi baselines`);
      return found;
    });

    expect(problems).toEqual([]);
  });

  it('the hand-written query shapes file is deleted and no test loads it', () => {
    expect(existsSync(join(__dirname, 'support', `${OLD_SHAPES}.ts`))).toBe(false);
    const loaders = testFiles(__dirname).filter((file) => {
      const text = source(file);
      return OLD_SHAPES_LOADS.some((load) => text.includes(load));
    });
    expect(loaders).toEqual([]);
  });
});
