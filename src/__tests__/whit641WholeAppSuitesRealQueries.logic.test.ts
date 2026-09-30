// WHIT-641 — the 7 whole-app suites run the real screen data code (src/queries.ts) over the fake
// server, instead of the hand-written shapes in support/screenQueryMocks.ts.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const WHOLE_APP_SUITES = [
  'overlaysRealData.screen.test.tsx',
  'optimisticSaveWriters.provider.screen.test.tsx',
  'sessionEpochAccessor.provider.screen.test.tsx',
  'sessionGuardRollbacks.provider.screen.test.tsx',
  'sessionGuardRollbacksRound2.provider.screen.test.tsx',
  'sessionGuardSaveRunner.provider.screen.test.tsx',
  'sessionGuardSaveRunnerQa.provider.screen.test.tsx',
];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('whole-app suites use the real screen data code', () => {
  it('none of the 7 suites mocks ../queries or uses the hand-written screenQueryMocks shapes', () => {
    const offenders = WHOLE_APP_SUITES.flatMap((file) => {
      const text = source(file);
      const problems: string[] = [];
      if (QUERIES_MOCK.test(text)) problems.push(`${file}: mocks ../queries`);
      if (text.includes('screenQueryMocks')) problems.push(`${file}: uses screenQueryMocks`);
      return problems;
    });

    expect(offenders).toEqual([]);
    expect(existsSync(join(__dirname, 'support', 'screenQueryMocks.ts'))).toBe(true);
  });

  it('overlaysRealData draws Overlays through the shared query setup, and all 7 are pinned in the fake-server baselines', () => {
    expect(existsSync(join(__dirname, 'support', 'renderWithQueries.tsx'))).toBe(true);

    const overlays = source('overlaysRealData.screen.test.tsx');
    expect(overlays).toMatch(/from ['"]\.\/support\/renderWithQueries['"]/);
    expect(overlays).toMatch(/useTestQueryClient\(\)/);
    expect(overlays).toMatch(/server\.seed\(['"]\/goals['"]/);
    expect(overlays).toMatch(/server\.seed\(['"]\/categories['"]/);
    expect(overlays).toMatch(/server\.seed\(['"]\/transactions['"]/);

    const baselines = source('noAutoMockApi.logic.test.ts');
    const unpinned = WHOLE_APP_SUITES.filter((file) => !baselines.includes(`'${file}':`));
    expect(unpinned).toEqual([]);
  });
});
