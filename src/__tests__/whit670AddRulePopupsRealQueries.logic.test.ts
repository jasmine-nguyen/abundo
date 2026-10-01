// WHIT-670 slice 1 — the 11 add-rule pop-up suites draw <Overlays/> over the fake server and the
// real screen data code (src/queries.ts), instead of the hand-written screenQueryMocks shapes.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

// Minimum expect( counts live in the noAutoMockApi baselines.
const ADD_RULE_SUITES = [
  'addRuleConfirmBudgetExcluded.screen.test.tsx',
  'addRulePreview.screen.test.tsx',
  'addRulePreviewGaps.screen.test.tsx',
  'AddRuleSheet.screen.test.tsx',
  'AddRuleSheetBudgetExcludedEdit.screen.test.tsx',
  'AddRuleSheetClassicPathUntouched.screen.test.tsx',
  'AddRuleSheetMultiCondition.screen.test.tsx',
  'AddRuleSheetMultiConditionGaps.screen.test.tsx',
  'AddRuleSheetOverlapWarning.screen.test.tsx',
  'AddRuleSheetSpread.screen.test.tsx',
  'AddRuleSheetSpreadGaps.screen.test.tsx',
];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const AUTH_MOCK = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)\s*\)/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('add-rule pop-up suites run on the fake server', () => {
  it('all 11 add-rule suites load categories, rules and charges from the fake server through the real query hooks', () => {
    const problems = ADD_RULE_SUITES.flatMap((file) => {
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
      return found;
    });

    expect(problems).toEqual([]);
  });

  it('the add-rule loading and error cases pause or fail the categories reply instead of faking hook flags', () => {
    const text = source('AddRuleSheet.screen.test.tsx');
    expect(text).not.toMatch(/categoriesLoading|categoriesError/);
    expect(text).toMatch(/server\.hold\(\s*['"]\/categories['"]\s*\)/);
    expect(text).toMatch(/server\.fail\(\s*['"]\/categories['"]\s*,\s*5\d\d/);
  });

  it('all 11 are listed in the fake-server baselines and in POPUP_SUITES', () => {
    const baselines = source('noAutoMockApi.logic.test.ts');
    const popupGuard = source('whit641WholeAppSuitesRealQueries.logic.test.ts');
    const problems = ADD_RULE_SUITES.flatMap((file) => {
      const found: string[] = [];
      if (!baselines.includes(`'${file}':`)) found.push(`${file}: not in the noAutoMockApi baselines`);
      if (!popupGuard.includes(`'${file}',`)) found.push(`${file}: not in POPUP_SUITES`);
      return found;
    });

    expect(problems).toEqual([]);
  });
});
