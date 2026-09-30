// WHIT-670 slice 2 — the 5 apply-rules pop-up suites draw <Overlays/> over the fake server and load
// categories through the real screen data code (src/queries.ts), instead of the hand-written
// screenQueryMocks shapes. The preview, filing and background-job writers stay on the context mock.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Today's expect( line count per suite — the move must keep at least this many.
const APPLY_RULES_SUITES: Record<string, number> = {
  'applyRulesJobSheet.screen.test.tsx': 16,
  'applyRulesJobStallSheet.screen.test.tsx': 8,
  'applyRulesJobVariantSheet.screen.test.tsx': 17,
  'applyRulesRounds.screen.test.tsx': 30,
  'applyRulesSheet.screen.test.tsx': 69,
};

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+queries['"]/;
const AUTH_MOCK = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)\s*\)/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');
const expectLines = (text: string) => text.split('\n').filter((line) => line.includes('expect(')).length;

describe('apply-rules pop-up suites run on the fake server', () => {
  it('all 5 apply-rules suites load categories from the fake server through the real query hooks', () => {
    const problems = Object.entries(APPLY_RULES_SUITES).flatMap(([file, baseline]) => {
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
      if (expectLines(text) < baseline) found.push(`${file}: expect( ${expectLines(text)} < ${baseline}`);
      return found;
    });

    expect(problems).toEqual([]);
    expect(existsSync(join(__dirname, 'support', 'screenQueryMocks.ts'))).toBe(true);
  });

  it('all 5 are pinned in the fake-server baselines at today\'s expect( count or higher', () => {
    const baselines = source('noAutoMockApi.logic.test.ts');
    const problems = Object.entries(APPLY_RULES_SUITES).flatMap(([file, baseline]) => {
      const escaped = file.replace(/\./g, '\\.');
      const match = baselines.match(new RegExp(`'${escaped}':\\s*(\\d+)`));
      if (!match) return [`${file}: not pinned`];
      if (Number(match[1]) < baseline) return [`${file}: pinned at ${match[1]} < ${baseline}`];
      return [];
    });

    expect(problems).toEqual([]);
  });
});
