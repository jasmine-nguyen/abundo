// WHIT-670 slice 1 — the 11 add-rule pop-up suites draw <Overlays/> over the fake server and the
// real screen data code (src/queries.ts), instead of the hand-written screenQueryMocks shapes.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Today's expect( line count per suite — the move must keep at least this many.
const ADD_RULE_SUITES: Record<string, number> = {
  'addRuleConfirmBudgetExcluded.screen.test.tsx': 3,
  'addRulePreview.screen.test.tsx': 17,
  'addRulePreviewGaps.screen.test.tsx': 26,
  'AddRuleSheet.screen.test.tsx': 55,
  'AddRuleSheetBudgetExcludedEdit.screen.test.tsx': 2,
  'AddRuleSheetClassicPathUntouched.screen.test.tsx': 8,
  'AddRuleSheetMultiCondition.screen.test.tsx': 19,
  'AddRuleSheetMultiConditionGaps.screen.test.tsx': 16,
  'AddRuleSheetOverlapWarning.screen.test.tsx': 10,
  'AddRuleSheetSpread.screen.test.tsx': 8,
  'AddRuleSheetSpreadGaps.screen.test.tsx': 6,
};

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const AUTH_MOCK = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)\s*\)/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');
const expectLines = (text: string) => text.split('\n').filter((line) => line.includes('expect(')).length;

describe('add-rule pop-up suites run on the fake server', () => {
  it('all 11 add-rule suites load categories, rules and charges from the fake server through the real query hooks', () => {
    const problems = Object.entries(ADD_RULE_SUITES).flatMap(([file, baseline]) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: mocks ../queries`);
      if (text.includes('screenQueryMocks')) found.push(`${file}: uses screenQueryMocks`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!/from ['"]\.\/support\/renderWithQueries['"]/.test(text)) found.push(`${file}: does not draw through renderWithQueries`);
      if (!AUTH_MOCK.test(text)) found.push(`${file}: does not mock ../auth via authMock`);
      if (!/resetAuth\(\)/.test(text)) found.push(`${file}: no resetAuth()`);
      if (!/server\.seed\(\s*['"]\/categories['"]/.test(text)) found.push(`${file}: never seeds /categories`);
      if (expectLines(text) < baseline) found.push(`${file}: expect( ${expectLines(text)} < ${baseline}`);
      return found;
    });

    expect(problems).toEqual([]);
    expect(existsSync(join(__dirname, 'support', 'screenQueryMocks.ts'))).toBe(true);
  });

  it('the add-rule loading and error cases pause or fail the categories reply instead of faking hook flags', () => {
    const text = source('AddRuleSheet.screen.test.tsx');
    expect(text).not.toMatch(/categoriesLoading|categoriesError/);
    expect(text).toMatch(/server\.hold\(\s*['"]\/categories['"]\s*\)/);
    expect(text).toMatch(/server\.fail\(\s*['"]\/categories['"]\s*,\s*5\d\d/);
  });

  it('all 11 are pinned in the fake-server baselines at today\'s expect( count or higher', () => {
    const baselines = source('noAutoMockApi.logic.test.ts');
    const problems = Object.entries(ADD_RULE_SUITES).flatMap(([file, baseline]) => {
      const escaped = file.replace(/\./g, '\\.');
      const match = baselines.match(new RegExp(`'${escaped}':\\s*(\\d+)`));
      if (!match) return [`${file}: not pinned`];
      if (Number(match[1]) < baseline) return [`${file}: pinned at ${match[1]} < ${baseline}`];
      return [];
    });

    expect(problems).toEqual([]);
  });
});
