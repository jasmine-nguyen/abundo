// WHIT-686 slice 3: the Uncategorised tab and filing button suites run the real screen data code
// over the pretend server, are off the allow-list in noQueriesMock.logic.test.ts, and the old
// pretend-data builder is gone.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

const QUERIES_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/m;

const SLICE_FILES = [
  'fileByShopButton.screen.test.tsx',
  'fileOneOffsIntent.screen.test.tsx',
  'fileOneOffsIntentGaps.screen.test.tsx',
  'uncategorizedCountWiring.screen.test.tsx',
  'uncategorizedMerchantsGate.screen.test.tsx',
  'uncategorizedMoreAffordance.screen.test.tsx',
  'applyRulesButton.screen.test.tsx',
];

const BUILDER = ['transactions', 'ScreenData'].join('');

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

describe('Uncategorised tab and filing button suites use the pretend server', () => {
  it('each suite draws the real screens over the pretend server instead of faking the screen data code', () => {
    const problems = SLICE_FILES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: still fakes the screen data code`);
      if (!text.includes('installFakeServer(')) found.push(`${file}: does not install the pretend server`);
      if (!text.includes('WithQueries')) found.push(`${file}: does not draw with renderWithQueries / WithQueries`);
      if (!text.includes('authMock')) found.push(`${file}: does not use authMock`);
      return found;
    });
    expect(problems).toEqual([]);
  });

  it('the count wiring suite still checks the warm-up read of the full feed on the pretend server', () => {
    expect(source('uncategorizedCountWiring.screen.test.tsx')).toMatch(
      /sentUnder\(\s*['"]GET['"]\s*,\s*['"]\/transactions\/feed['"]/,
    );
  });

  it('none of the moved suites is left on the allow-list, and the old pretend-data builder is deleted', () => {
    const allowList = source('noQueriesMock.logic.test.ts');
    expect(SLICE_FILES.filter((file) => allowList.includes(`'${file}'`))).toEqual([]);

    expect(existsSync(join(__dirname, 'support', `${BUILDER}.ts`))).toBe(false);
    const importer = new RegExp(`['"]\\./support/${BUILDER}['"]`);
    const users = testFiles(__dirname).filter((file) => importer.test(source(file)));
    expect(users).toEqual([]);

    const walker = source('whit673TestFilesWalker.logic.test.ts');
    expect(walker).toContain(`expect(files).toContain('support/fakeServer.ts');`);
    expect(walker).not.toContain(`'support/${BUILDER}.ts'`);
  });
});
