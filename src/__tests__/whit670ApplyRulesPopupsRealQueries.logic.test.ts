// WHIT-670 slice 2 — the 5 apply-rules pop-up suites draw <Overlays/> over the fake server and load
// categories through the real screen data code (src/queries.ts), instead of the hand-written
// screenQueryMocks shapes. The preview, filing and background-job writers stay on the context mock.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Minimum expect( counts live in the noAutoMockApi baselines.
const APPLY_RULES_SUITES = [
  'applyRulesJobSheet.screen.test.tsx',
  'applyRulesJobStallSheet.screen.test.tsx',
  'applyRulesJobVariantSheet.screen.test.tsx',
  'applyRulesRounds.screen.test.tsx',
  'applyRulesSheet.screen.test.tsx',
];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const AUTH_MOCK = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)\s*\)/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('apply-rules pop-up suites run on the fake server', () => {
  it('all 5 apply-rules suites load categories from the fake server through the real query hooks', () => {
    const problems = APPLY_RULES_SUITES.flatMap((file) => {
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
      if (/categories:\s*CATEGORIES/.test(text)) found.push(`${file}: still puts categories on the context mock`);
      return found;
    });

    expect(problems).toEqual([]);
    expect(existsSync(join(__dirname, 'support', 'screenQueryMocks.ts'))).toBe(true);
  });

  it('all 5 are listed in the fake-server baselines and in POPUP_SUITES', () => {
    const baselines = source('noAutoMockApi.logic.test.ts');
    const popupGuard = source('whit641WholeAppSuitesRealQueries.logic.test.ts');
    const problems = APPLY_RULES_SUITES.flatMap((file) => {
      const found: string[] = [];
      if (!baselines.includes(`'${file}':`)) found.push(`${file}: not in the noAutoMockApi baselines`);
      if (!popupGuard.includes(`'${file}',`)) found.push(`${file}: not in POPUP_SUITES`);
      return found;
    });

    expect(problems).toEqual([]);
  });
});
