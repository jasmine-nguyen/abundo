// WHIT-671 — the file-by-shop, filing-suggestions, goal-balance, pay-cycle and sheet-motion pop-up
// suites draw <Overlays/> over the fake server (support/openOverlays) instead of hand-written
// query shapes, and each is pinned in both guard lists without losing checks.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

// file → its expect( line count before the move (the floor it must keep).
const MOVED_SUITES: Record<string, number> = {
  'fileByShopOffScreenClash.screen.test.tsx': 2,
  'fileByShopSheet.screen.test.tsx': 21,
  'fileByShopSheetGaps.screen.test.tsx': 27,
  'filingSuggestions.screen.test.tsx': 8,
  'filingSuggestions.gaps.screen.test.tsx': 6,
  'goalBalanceSheet.screen.test.tsx': 28,
  'PayCycleSheet.screen.test.tsx': 7,
  'sheetHostMotion.screen.test.tsx': 38,
};

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const OLD_SHAPES = ['screen', 'Query', 'Mocks'].join('');

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('WHIT-671 pop-up suites run on the fake server', () => {
  it('each moved suite opens Overlays over the fake server, keeps its checks, and is pinned in both guards', () => {
    const popupGuard = source('whit641WholeAppSuitesRealQueries.logic.test.ts');
    const baselines = source('noAutoMockApi.logic.test.ts');

    const problems = Object.entries(MOVED_SUITES).flatMap(([file, floor]) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: mocks ../queries`);
      if (text.includes(OLD_SHAPES)) found.push(`${file}: uses the hand-written query shapes`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!/from ['"]\.\/support\/openOverlays['"]/.test(text)) found.push(`${file}: does not open via support/openOverlays`);
      const expectLines = text.split('\n').filter((line) => line.includes('expect(')).length;
      if (expectLines < floor) found.push(`${file}: expect( ${expectLines} < ${floor}`);
      if (!popupGuard.includes(`'${file}',`)) found.push(`${file}: not in POPUP_SUITES`);
      if (!baselines.includes(`'${file}':`)) found.push(`${file}: not in the noAutoMockApi baselines`);
      return found;
    });

    expect(problems).toEqual([]);
  });
});
