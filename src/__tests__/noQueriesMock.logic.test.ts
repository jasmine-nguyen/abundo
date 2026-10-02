// No new test may fake the screen data code (src/queries.ts): a fake skips the real hooks, so a
// change to their shape keeps passing. Suites use `installFakeServer()` + `renderWithQueries` instead.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

export const QUERIES_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/m;

// This list may only shrink. Move a file onto the fake server (or delete it if it only checks
// layout or animation), then remove its line here.
const ALLOWED = new Set<string>([
  'applyRulesButton.screen.test.tsx',
  'categoryDetail.screen.test.tsx',
  'categoryEditSummaryToast.screen.test.tsx',
  'categoryFields.screen.test.tsx',
  'equityCardDepositTarget.screen.test.tsx',
  'fileByShopButton.screen.test.tsx',
  'fileOneOffsIntent.screen.test.tsx',
  'fileOneOffsIntentGaps.screen.test.tsx',
  'goalEdit.screen.test.tsx',
  'goalErrorStates.a11y.screen.test.tsx',
  'goals.paydown.screen.test.tsx',
  'goalsCheckpointCelebration.screen.test.tsx',
  'goalsCheckpointCelebrationPaydown.screen.test.tsx',
  'goalsHub.screen.test.tsx',
  'goalsHubEdges.screen.test.tsx',
  'goalsHubOverpaid.screen.test.tsx',
  'goalsHubOwing.screen.test.tsx',
  'goalsHubPayoffFloor.screen.test.tsx',
  'goalsHubPureHero.screen.test.tsx',
  'goalTooAggressive.screen.test.tsx',
  'milestone.screen.test.tsx',
  'mortgage.screen.test.tsx',
  'repayment.edges.screen.test.tsx',
  'repayment.errorBoundary.screen.test.tsx',
  'transactionDetail.screen.test.tsx',
  'transactionDetailDeleteGaps.screen.test.tsx',
  'transactionEdit.screen.test.tsx',
  'transactionsAccountsRemoved.screen.test.tsx',
  'transactionSpread.gap.screen.test.tsx',
  'transactionsScreenStates.screen.test.tsx',
  'transactionsSearchGaps.screen.test.tsx',
  'transactionsSearchServer.screen.test.tsx',
  'uncategorizedCountWiring.screen.test.tsx',
  'uncategorizedMerchantsGate.screen.test.tsx',
  'uncategorizedMoreAffordance.screen.test.tsx',
  'whit328SelectGap.screen.test.tsx',
  'whit330Transactions.screen.test.tsx',
]);

function mocksQueries(file: string): boolean {
  return QUERIES_MOCK.test(readFileSync(join(__dirname, file), 'utf8'));
}

describe('no new test mocks the screen data code', () => {
  it('no new test mocks the screen data code', () => {
    expect(testFiles(__dirname).filter((file) => mocksQueries(file) && !ALLOWED.has(file))).toEqual([]);
  });

  it('the allow-list only shrinks', () => {
    const files = new Set(testFiles(__dirname));
    const stale = [...ALLOWED].flatMap((file) => {
      if (!files.has(file)) return [`${file}: no longer exists — remove it from ALLOWED`];
      if (!mocksQueries(file)) return [`${file}: no longer mocks ../queries — remove it from ALLOWED`];
      return [];
    });
    expect(stale).toEqual([]);
  });

  it('the pattern catches every way of writing the queries mock and ignores comments and look-alikes', () => {
    expect(`jest.mock('../queries', () => ({}))`).toMatch(QUERIES_MOCK);
    expect(`jest.mock('../../src/queries', () => ({}))`).toMatch(QUERIES_MOCK);
    expect(`jest.doMock("../queries")`).toMatch(QUERIES_MOCK);
    expect(`\tjest.mock('../queries', () => ({}));`).toMatch(QUERIES_MOCK);
    expect(`jest.mock(\n  '../queries',\n  () => ({}),\n);`).toMatch(QUERIES_MOCK);
    expect(`// jest.mock('../queries')`).not.toMatch(QUERIES_MOCK);
    expect(`jest.mock('../queryClient')`).not.toMatch(QUERIES_MOCK);
    expect(`jest.mock('./support/queries')`).not.toMatch(QUERIES_MOCK);
    expect(`jest.mock('../queriesX')`).not.toMatch(QUERIES_MOCK);
    expect(`const hint = "jest.mock('../queries')";`).not.toMatch(QUERIES_MOCK);
  });
});
