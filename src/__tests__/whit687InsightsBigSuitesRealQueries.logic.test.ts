// WHIT-687 slice 3 — the main Insights test and the category-colour test draw the real Insights tab
// over the fake server with the real screen data code, instead of hand-made query stand-ins.
// Both are off the noQueriesMock exceptions list and pinned in the noAutoMockApi baselines.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

// The minimum check counts live once, in the noAutoMockApi baselines (WHIT-682).
const BIG_SUITES = ['insightsColourSlots.screen.test.tsx', 'InsightsScreen.screen.test.tsx'];

const QUERIES_MOCK = /jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/;
const AUTH_MOCK_MODULE = /jest\.mock\(\s*['"]\.\.\/auth['"],\s*\(\)\s*=>\s*require\(['"]\.\/support\/authMock['"]\)\.authMockModule\(\)/;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function allowedBlock(): string {
  const text = source('noQueriesMock.logic.test.ts');
  const start = text.indexOf('const ALLOWED');
  return text.slice(start, text.indexOf(']);', start));
}

function hasBaseline(file: string): boolean {
  return source('noAutoMockApi.logic.test.ts').includes(`'${file}':`);
}

describe('WHIT-687 the two big Insights suites run on the fake server', () => {
  it('each big Insights suite runs the real screen data code over the fake server, keeps its checks, and is pinned in both guards', () => {
    const allowed = allowedBlock();

    const problems = BIG_SUITES.flatMap((file) => {
      const text = source(file);
      const found: string[] = [];
      if (QUERIES_MOCK.test(text)) found.push(`${file}: mocks ../queries`);
      if (!/installFakeServer\(\)/.test(text)) found.push(`${file}: no installFakeServer()`);
      if (!/useTestQueryClient\(\)/.test(text)) found.push(`${file}: no useTestQueryClient()`);
      if (!AUTH_MOCK_MODULE.test(text)) found.push(`${file}: does not use the shared authMockModule()`);
      if (!text.includes('./support/insightsScreen')) found.push(`${file}: does not use the shared Insights test kit`);
      if (allowed.includes(`'${file}'`)) found.push(`${file}: still on the noQueriesMock ALLOWED list`);
      if (!hasBaseline(file)) found.push(`${file}: not in the noAutoMockApi baselines`);
      return found;
    });

    expect(problems).toEqual([]);
  });

  it('the focus-refresh check proves a NEW breakdown read happens on focus, not just the first load', () => {
    const text = source('InsightsScreen.screen.test.tsx');
    const start = text.indexOf('refreshes breakdown');
    expect(start).toBeGreaterThan(-1);
    const block = text.slice(start, text.indexOf('\n});', start));

    const problems: string[] = [];
    // sentUnder: the app always adds ?days=… to the breakdown address, which sent() (exact path) never matches.
    const countsReads = /server\.sent(Under)?\(\s*['"]GET['"],\s*['"]\/breakdown['"]\s*\)\.length/;
    const helper = text.match(/const (\w+) = \(\) => server\.sentUnder\(\s*['"]GET['"],\s*['"]\/breakdown['"]\s*\)\.length/);
    const countsViaHelper = helper !== null && block.includes(`${helper[1]}()`);
    if (!countsReads.test(block) && !countsViaHelper) problems.push('does not count breakdown reads');
    if (!/invalidateQueries|setDefaultOptions/.test(block)) problems.push('does not make the cached breakdown stale first');
    if (!/mockFocus\(\)/.test(block)) problems.push('does not fire the stored focus callback');
    if (!/refreshAiInsights/.test(block)) problems.push('lost the AI refresh check');
    expect(problems).toEqual([]);
  });
});
