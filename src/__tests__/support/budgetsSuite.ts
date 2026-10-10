// WHIT-734 — the ../context mock the Budgets-tab screen suites share. Usage in a suite:
//
//   jest.mock('../context', () => require('./support/budgetsSuite').budgetsContextMockModule());
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { jest } from '@jest/globals';
import { realContextWith } from './contextMock';

// The real ../context, with the screen's delete/picker actions stubbed out.
export function budgetsContextMockModule() {
  return realContextWith(() => ({ deleteBudget: jest.fn(), openPicker: jest.fn() }));
}
