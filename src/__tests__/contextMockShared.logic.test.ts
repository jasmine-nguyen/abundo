// WHIT-777 — screen suites share one ../context stand-in builder (support/contextMock
// realContextWith / emptyContextMockModule) instead of each hand-copying the empty one.
// WHIT-800 — the transactions, uncategorised, budgets, category and picker-sheet suites
// take their ../context stand-in from the shared builder instead of hand-building one.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

const INLINE_EMPTY = /useAppContext:\s*\(\)\s*=>\s*\(\{\s*\}\)/;
const HAND_BUILT = /requireActual\(\s*['"]\.\.\/context['"]\s*\)/;

const SLICE_3_SUITES = [
  'transactionDetail',
  'transactionDetailDeleteGaps',
  'transactionEdit',
  'TransactionRow',
  'transactionsAccountsRemoved',
  'transactionSpread.gap',
  'transactionsScreenData',
  'transactionsScreenStates',
  'transactionsSearchGaps',
  'transactionsSearchServer',
  'whit328SelectGap',
  'whit330Transactions',
  'whit686DetailScreenQa',
  'whit686ListQa',
  'uncategorizedCountWiring',
  'uncategorizedMerchantsGate',
  'uncategorizedMoreAffordance',
  'uncategorizedMoreState',
  'whit686UncategorizedCountFailed',
  'budgetDetailDeleteConfirm',
  'budgetDetailLoadMore',
  'budgetEditSave',
  'budgetSpread',
  'budgetSpreadGaps',
  'whit745OverFirstOnly',
  'whit745OverFirstOnlyQa',
  'categoryDetail',
  'incomeCategory',
  'pickerSheetTree',
  'multiSelectSheet',
  'confirmSheetMountStability',
  'confirmSheetRefile',
  'whit670PickerConfirmQa',
].map((name) => `${name}.screen.test.tsx`);

const offendersOf = (files: string[], pattern: RegExp) =>
  files.filter((file) => pattern.test(readFileSync(join(__dirname, file), 'utf8')));

describe('screen suites share one context stand-in', () => {
  it('no test file keeps its own empty context stand-in', () => {
    expect(offendersOf(testFiles(__dirname), INLINE_EMPTY)).toEqual([]);
  });

  it('the transactions, budgets, category and picker suites do not hand-build their context stand-in', () => {
    expect(offendersOf(SLICE_3_SUITES, HAND_BUILT)).toEqual([]);
  });
});
