// WHIT-688 slice 1: the tab bar and Settings suites run the real screen data code over the fake
// server, and the eight files are off the shrink-only allow-list.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { QUERIES_MOCK } from './noQueriesMock.logic.test';

const SLICE_FILES = [
  'settingsGear.screen.test.tsx',
  'settingsGearSelection.screen.test.tsx',
  'settingsLogout.screen.test.tsx',
  'settingsProfile.screen.test.tsx',
  'tabBadgeQuery.screen.test.tsx',
  'tabBarNoSettings.screen.test.tsx',
  'tabDotNotDuplicated.screen.test.tsx',
  'whit330TabDot.screen.test.tsx',
];

const FAKE_SERVER_SUITES = [
  'tabBarDot.screen.test.tsx',
  'settingsScreen.screen.test.tsx',
  'settingsGear.screen.test.tsx',
  'settingsGearSelection.screen.test.tsx',
];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function allowList(): string[] {
  const body = read('noQueriesMock.logic.test.ts').match(/const ALLOWED = new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!body) throw new Error('ALLOWED not found in noQueriesMock.logic.test.ts');
  return [...body[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('tab bar and Settings tests run the real screen data code', () => {
  it('the eight tab bar and Settings files are off the allow-list and none fakes the screen data code', () => {
    const allowed = allowList();
    expect(SLICE_FILES.filter((file) => allowed.includes(file))).toEqual([]);
    expect(SLICE_FILES.filter((file) => existsSync(join(__dirname, file)) && QUERIES_MOCK.test(read(file)))).toEqual(
      [],
    );
  });

  it('the tab bar dot, Settings screen and Settings gear suites draw over the fake server', () => {
    const notOnFakeServer = FAKE_SERVER_SUITES.filter((file) => {
      if (!existsSync(join(__dirname, file))) return true;
      const source = read(file);
      return QUERIES_MOCK.test(source) || !/installFakeServer\(\)/.test(source) || !/renderWithQueries/.test(source);
    });
    expect(notOnFakeServer).toEqual([]);
  });
});
