// No test may mock api.ts in any form (bare auto-mock, factory mock, jest.doMock): a mock skips
// the real request code (src/api.ts). Suites use `installFakeServer()` instead.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const API_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+api['"]/m;

// Shrinks as later cards move these suites onto the fake server; deleted once empty.
const STILL_TO_MOVE = [
  // WHIT-660
  'insightsBreakdownQuery.screen.test.tsx',
  'insightsBreakdownCacheFirst.screen.test.tsx',
  'insightsBreakdownTree.gaps.screen.test.tsx',
  'insightsCategoryDrill.screen.test.tsx',
  'insightsCycleToggle.gaps.screen.test.tsx',
  'insightsScreenData.edges.screen.test.tsx',
  'goalScreenData.screen.test.tsx',
  'goalScreenData.edges.screen.test.tsx',
  'goalKeepLastGood.edges.screen.test.tsx',
  'goalsScreenData.screen.test.tsx',
  'payCycleServerDaysLeft.screen.test.tsx',
  // WHIT-661
  'transactionsScreenData.screen.test.tsx',
  'transactionsSearchQueries.screen.test.tsx',
  'transactionsSearchRefresh.screen.test.tsx',
  'uncategorizedFeedQueries.screen.test.tsx',
  'uncategorizedMoreState.screen.test.tsx',
  'txResolverMergeGaps.screen.test.tsx',
  'pullToRefreshLiveBalances.screen.test.tsx',
  'pullToRefreshSuccessToastGaps.screen.test.tsx',
  'budgetsQuery.screen.test.tsx',
  'settingsQuery.screen.test.tsx',
  'screenQueryHooks.screen.test.tsx',
];

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    return [relative(__dirname, path)];
  });
}

function mocksApi(file: string): boolean {
  return API_MOCK.test(readFileSync(join(__dirname, file), 'utf8'));
}

describe('no test mocks the api', () => {
  it('no file outside the still-to-move list mocks the api', () => {
    const offenders = testFiles(__dirname).filter(
      (file) => mocksApi(file) && !STILL_TO_MOVE.includes(file),
    );

    expect(offenders).toEqual([]);
  });

  it('every file on the still-to-move list still mocks the api, so the list only shrinks', () => {
    const alreadyMoved = STILL_TO_MOVE.filter((file) => !mocksApi(file));

    expect(alreadyMoved).toEqual([]);
  });

  it('the moved suites run on the fake server and keep their expect( count', () => {
    const baselines: Record<string, number> = {
      'loanFactsWrite.provider.screen.test.tsx': 8,
      'goalsWrite.provider.screen.test.tsx': 53,
      'goalSaveCoexistence.provider.screen.test.tsx': 3,
      'optimisticSaveWriters.provider.screen.test.tsx': 49,
      'budgetTxOptimistic.provider.screen.test.tsx': 64,
      'budgetTxEditGaps.provider.screen.test.tsx': 9,
      'whit525Gaps.provider.screen.test.tsx': 7,
      'appProvider.screen.test.tsx': 101,
      'overlaysRealData.screen.test.tsx': 100,
      'askButton.screen.test.tsx': 8,
      'chatSheet.screen.test.tsx': 34,
      'chatContext.provider.screen.test.tsx': 54,
      'chatContextEdges.screen.test.tsx': 13,
      'push.screen.test.tsx': 62,
      'rulesScreenData.screen.test.tsx': 17,
      'rulesBadgeDivergence.screen.test.tsx': 3,
      'uncategorizedCountHook.screen.test.tsx': 13,
      'uncategorizedMerchantsHook.screen.test.tsx': 8,
      'categoryRangeQuery.screen.test.tsx': 8,
      'categoryRangeQueryEdges.screen.test.tsx': 10,
    };

    const shortfalls = Object.entries(baselines).flatMap(([file, baseline]) => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      const expectLines = source.split('\n').filter((line) => line.includes('expect(')).length;
      const problems: string[] = [];
      if (!/installFakeServer\(\)/.test(source)) problems.push(`${file}: no installFakeServer()`);
      if (expectLines < baseline) problems.push(`${file}: expect( ${expectLines} < ${baseline}`);
      return problems;
    });

    expect(shortfalls).toEqual([]);
  });

  it('the pattern catches bare, factory and doMock mocks of the api and ignores comments and look-alikes', () => {
    expect(`jest.mock('../api');`).toMatch(API_MOCK);
    expect(`import x from 'y';\n  jest.mock("../../api")`).toMatch(API_MOCK);
    expect(`jest.mock('../api', () => ({}));`).toMatch(API_MOCK);
    expect(`jest.mock('../api', () => ({\n  fetchX: () => mockFetchX(),\n}));`).toMatch(API_MOCK);
    expect(`jest.doMock('../api', () => ({}));`).toMatch(API_MOCK);
    expect(`// used instead of jest.mock('../api')`).not.toMatch(API_MOCK);
    expect(`jest.mock('../apiWire');`).not.toMatch(API_MOCK);
  });

  // [A1] WHIT-640 QA — layouts the factory form really takes, and near-miss module names.
  it('the pattern catches tab-indented, line-broken and deep-path mocks and skips other api* modules', () => {
    expect(`\tjest.mock('../api', () => ({}));`).toMatch(API_MOCK);
    expect(`jest.mock(\n  '../api',\n  () => ({ fetchX: jest.fn() }),\n);`).toMatch(API_MOCK);
    expect(`jest.mock("../../../api", () => ({}));`).toMatch(API_MOCK);
    expect(`  jest.doMock("../api");`).toMatch(API_MOCK);
    expect(`jest.mock('../apiError', () => ({}));`).not.toMatch(API_MOCK);
    expect(`jest.mock('../api-client');`).not.toMatch(API_MOCK);
    expect(`jest.mock('./support/api');`).not.toMatch(API_MOCK);
    expect(`const hint = "jest.mock('../api')";`).not.toMatch(API_MOCK);
  });

  // [A2]
  it('the still-to-move list names each file once', () => {
    expect(STILL_TO_MOVE.filter((file, i) => STILL_TO_MOVE.indexOf(file) !== i)).toEqual([]);
  });
});
