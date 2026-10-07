// WHIT-800 — the transactions, uncategorised, budgets, category and picker-sheet screen suites
// take their ../context stand-in from the shared builder (support/contextMock realContextWith,
// or support/budgetsSuite budgetsContextMockModule) instead of hand-building one.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const SUITES = [
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

const HAND_BUILT = /requireActual\(\s*['"]\.\.\/context['"]\s*\)/;
const SHARED = /require\(\s*['"]\.\/support\/(contextMock|budgetsSuite)['"]\s*\)\s*\.(realContextWith|budgetsContextMockModule)\(/;

describe('transactions, budgets, category and picker screen suites share the context stand-in', () => {
  it('each suite mocks ../context through the shared builder, not a hand-built copy', () => {
    const offenders = SUITES.filter((file) => {
      const source = readFileSync(join(__dirname, file), 'utf8');
      return HAND_BUILT.test(source) || !SHARED.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
