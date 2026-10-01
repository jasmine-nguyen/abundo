// WHIT-671 — the file-by-shop, filing-suggestions, goal-balance, pay-cycle and sheet-motion pop-up
// suites draw <Overlays/> over the fake server (support/openOverlays) instead of hand-written
// query shapes, and each is pinned in both guard lists. Their minimum expect( counts live in the
// noAutoMockApi baselines.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const MOVED_SUITES = [
  'fileByShopOffScreenClash.screen.test.tsx',
  'fileByShopSheet.screen.test.tsx',
  'fileByShopSheetGaps.screen.test.tsx',
  'filingSuggestions.screen.test.tsx',
  'filingSuggestions.gaps.screen.test.tsx',
  'goalBalanceSheet.screen.test.tsx',
  'PayCycleSheet.screen.test.tsx',
  'sheetHostMotion.screen.test.tsx',
];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const OLD_SHAPES = ['screen', 'Query', 'Mocks'].join('');

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('WHIT-671 pop-up suites run on the fake server', () => {
  it('each moved suite opens Overlays over the fake server and is pinned in both guards', () => {
    const popupGuard = source('whit641WholeAppSuitesRealQueries.logic.test.ts');
    const baselines = source('noAutoMockApi.logic.test.ts');

    const problems = MOVED_SUITES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: mocks ../queries`);
      if (text.includes(OLD_SHAPES)) found.push(`${file}: uses the hand-written query shapes`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!/from ['"]\.\/support\/openOverlays['"]/.test(text)) found.push(`${file}: does not open via support/openOverlays`);
      if (!popupGuard.includes(`'${file}',`)) found.push(`${file}: not in POPUP_SUITES`);
      if (!baselines.includes(`'${file}':`)) found.push(`${file}: not in the noAutoMockApi baselines`);
      return found;
    });

    expect(problems).toEqual([]);
  });
});
