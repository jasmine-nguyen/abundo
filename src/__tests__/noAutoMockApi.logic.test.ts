// No test may mock api.ts in any form (bare auto-mock, factory mock, jest.doMock): a mock skips
// the real request code (src/api.ts). Suites use `installFakeServer()` instead.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

const API_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+api['"]/m;

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
  it('no test file mocks the api', () => {
    expect(testFiles(__dirname).filter(mocksApi)).toEqual([]);
  });

  it('the moved suites run on the fake server and keep their expect( count', () => {
    const baselines: Record<string, number> = {
      'loanFactsWrite.provider.screen.test.tsx': 8,
      'goalsWrite.provider.screen.test.tsx': 53,
      'goalSaveCoexistence.provider.screen.test.tsx': 3,
      'optimisticSaveWriters.provider.screen.test.tsx': 53,
      'sessionEpochAccessor.provider.screen.test.tsx': 3,
      'sessionGuardRollbacks.provider.screen.test.tsx': 59,
      'sessionGuardRollbacksRound2.provider.screen.test.tsx': 3,
      'sessionGuardSaveRunner.provider.screen.test.tsx': 4,
      'sessionGuardSaveRunnerQa.provider.screen.test.tsx': 45,
      'budgetTxOptimistic.provider.screen.test.tsx': 64,
      'budgetTxEditGaps.provider.screen.test.tsx': 9,
      'whit525Gaps.provider.screen.test.tsx': 7,
      'appProvider.screen.test.tsx': 101,
      'overlaysRealData.screen.test.tsx': 105,
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
      'insightsBreakdownQuery.screen.test.tsx': 42,
      'insightsBreakdownCacheFirst.screen.test.tsx': 4,
      'insightsBreakdownTree.gaps.screen.test.tsx': 26,
      'insightsCategoryDrill.screen.test.tsx': 6,
      'insightsCycleToggle.gaps.screen.test.tsx': 19,
      'insightsScreenData.edges.screen.test.tsx': 28,
      'goalScreenData.screen.test.tsx': 35,
      'goalScreenData.edges.screen.test.tsx': 33,
      'goalKeepLastGood.edges.screen.test.tsx': 12,
      'goalsScreenData.screen.test.tsx': 45,
      'payCycleServerDaysLeft.screen.test.tsx': 8,
      'transactionsScreenData.screen.test.tsx': 106,
      'transactionsSearchQueries.screen.test.tsx': 35,
      'transactionsSearchRefresh.screen.test.tsx': 7,
      'uncategorizedFeedQueries.screen.test.tsx': 32,
      'uncategorizedMoreState.screen.test.tsx': 10,
      'txResolverMergeGaps.screen.test.tsx': 19,
      'pullToRefreshLiveBalances.screen.test.tsx': 25,
      'pullToRefreshSuccessToastGaps.screen.test.tsx': 14,
      'budgetsQuery.screen.test.tsx': 118,
      'settingsQuery.screen.test.tsx': 87,
      'screenQueryHooks.screen.test.tsx': 52,
      'addRuleConfirmBudgetExcluded.screen.test.tsx': 3,
      'addRulePreview.screen.test.tsx': 17,
      'addRulePreviewGaps.screen.test.tsx': 26,
      'AddRuleSheet.screen.test.tsx': 57,
      'AddRuleSheetBudgetExcludedEdit.screen.test.tsx': 2,
      'AddRuleSheetClassicPathUntouched.screen.test.tsx': 8,
      'AddRuleSheetMultiCondition.screen.test.tsx': 19,
      'AddRuleSheetMultiConditionGaps.screen.test.tsx': 16,
      'AddRuleSheetOverlapWarning.screen.test.tsx': 10,
      'AddRuleSheetSpread.screen.test.tsx': 8,
      'AddRuleSheetSpreadGaps.screen.test.tsx': 6,
      'applyRulesJobSheet.screen.test.tsx': 16,
      'applyRulesJobStallSheet.screen.test.tsx': 8,
      'applyRulesJobVariantSheet.screen.test.tsx': 17,
      'applyRulesRounds.screen.test.tsx': 30,
      'applyRulesSheet.screen.test.tsx': 69,
      'confirmSheetMountStability.screen.test.tsx': 5,
      'confirmSheetRefile.screen.test.tsx': 8,
      'incomeCategory.screen.test.tsx': 18,
      'multiSelectSheet.screen.test.tsx': 6,
      'pickerSheetTree.screen.test.tsx': 54,
      'fileByShopOffScreenClash.screen.test.tsx': 2,
      'fileByShopSheet.screen.test.tsx': 21,
      'fileByShopSheetGaps.screen.test.tsx': 27,
      'filingSuggestions.screen.test.tsx': 8,
      'filingSuggestions.gaps.screen.test.tsx': 6,
      'goalBalanceSheet.screen.test.tsx': 28,
      'PayCycleSheet.screen.test.tsx': 7,
      'sheetHostMotion.screen.test.tsx': 38,
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
});
